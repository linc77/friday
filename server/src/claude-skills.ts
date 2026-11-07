/*
Adapted from T3 Code 8cd9641f provider/Drivers/ClaudeSkills.ts.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { parse as parseYamlDocument } from 'yaml';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

export type ProviderSkill = { name: string; path: string; description?: string; shortDescription?: string; displayName?: string; scope?: string; enabled: boolean; userInvocationOnly?: boolean; userInvocable?: boolean };
type ClaudeSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`), which the 1.2 core schema this parser uses leaves as strings and
 * numbers.
 */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const frontmatter = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(frontmatter);
  } catch {
    // Claude Code accepts plain scalars containing `: `. Repair only those,
    // leaving comments and YAML structure for the full-document parser.
    const repaired = frontmatter.replace(
      /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
      (line, prefix: string, value: string) => {
        const scalar = value.split(/[ \t]+#/)[0] ?? "";
        if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
          return line;
        }
        return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
      },
    );
    try {
      parsed = parseYamlDocument(repaired);
    } catch {
      return { kind: "malformed" };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

async function contents(path: string) { try { return await readFile(path, 'utf8'); } catch { return undefined; } }
async function repositoryRoot(cwd: string) {
  let current = resolve(cwd);
  while (true) {
    try { await access(join(current, '.git')); return current; } catch {}
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
export async function discoverClaudeSkills(home: string, cwd: string, environment: NodeJS.ProcessEnv = process.env, additionalDirectory?: string, platform: NodeJS.Platform = process.platform): Promise<ProviderSkill[]> {
  const root = await repositoryRoot(cwd);
  const managed = platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : platform === 'win32' ? environment.PROGRAMDATA?.trim() && join(environment.PROGRAMDATA.trim(), 'ClaudeCode', 'managed-settings.json') : '/etc/claude-code/managed-settings.json';
  const paths = [join(home, 'settings.json'), join(cwd, '.claude/settings.json'), join(cwd, '.claude/settings.local.json'),
    ...(root && root !== cwd ? [join(root, '.claude/settings.local.json')] : []), ...(managed ? [managed] : [])];
  const overrides = new Map<string, { enabled: boolean; userInvocationOnly: boolean }>();
  for (const path of paths) {
    const text = await contents(path); if (text === undefined) continue;
    const errors: ParseError[] = []; const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
    const values = parsed?.skillOverrides;
    if (errors.length || !values || typeof values !== 'object' || Array.isArray(values)
      || Object.values(values).some(value => !['on', 'name-only', 'user-invocable-only', 'off'].includes(value as string))) continue;
    for (const [name, value] of Object.entries(values)) overrides.set(name, { enabled: value !== 'off', userInvocationOnly: value === 'user-invocable-only' });
  }
  const roots: { directory: string; scope: ClaudeSkillScope }[] = [
    { directory: join(home, 'skills'), scope: 'user' }, { directory: join(cwd, '.claude/skills'), scope: 'project' },
    ...(additionalDirectory ? [{ directory: join(resolve(cwd, additionalDirectory), '.claude/skills'), scope: 'project' as const }] : []),
  ];
  const skills = new Map<string, ProviderSkill>();
  for (const root of roots) {
    const entries = await readdir(root.directory).catch(() => [] as string[]);
    for (const entry of entries.sort()) {
      const path = join(root.directory, entry, 'SKILL.md'), text = await contents(path); if (text === undefined) continue;
      const frontmatter = parseSkillFrontmatter(text); if (frontmatter.kind === 'malformed') continue;
      const name = entry.trim(); if (!name || skills.has(name)) continue;
      const override = overrides.get(name);
      skills.set(name, { name, path, scope: root.scope, enabled: override?.enabled ?? true,
        ...(frontmatter.kind === 'parsed' && frontmatter.description ? { description: frontmatter.description } : {}),
        ...(frontmatter.kind === 'parsed' && frontmatter.userInvocable === false ? { userInvocable: false } : {}),
        ...(frontmatter.kind === 'parsed' && frontmatter.userInvocationOnly || override?.userInvocationOnly ? { userInvocationOnly: true } : {}) });
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}
