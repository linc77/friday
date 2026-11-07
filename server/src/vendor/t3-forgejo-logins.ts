/*
Adapted from T3 Code 8cd9641f packages/source-control-forgejo/src/server/ForgejoCli.ts.
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
export type ForgejoLogin = { name: string; url: string; ssh_host?: string; valid?: string; user: string; default: string };

export function parseForgejoRemote(value: string) {
  if (/^(?:https?|ssh):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return {
        host: url.host.toLowerCase(),
        hostname: url.hostname.toLowerCase(),
        ssh: url.protocol === "ssh:",
        path: url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""),
      };
    } catch {
      return null;
    }
  }
  // SCP remotes may omit the username; URL treats these as a custom scheme.
  const ssh = /^(?:[^@/]+@)?([^:/]+):([^/].*)$/.exec(value);
  return ssh?.[1] && ssh[2]
    ? {
        host: ssh[1].toLowerCase(),
        hostname: ssh[1].toLowerCase(),
        ssh: true,
        path: ssh[2].replace(/\.git$/, ""),
      }
    : null;
}

export function matchForgejoLogin(
  logins: ForgejoLogin[],
  remote: NonNullable<ReturnType<typeof parseForgejoRemote>>,
  requestedHost?: string,
  hostOnly = false,
) {
  const matches = [
    ...new Map(
      logins
        .filter((login) => {
          const url = parseForgejoRemote(login.url);
          if (!url) return false;
          if (requestedHost !== undefined && url.host !== requestedHost.toLowerCase()) return false;
          return remote.ssh
            ? login.ssh_host?.toLowerCase() === remote.host ||
                login.ssh_host?.toLowerCase() === remote.hostname ||
                url.hostname === remote.hostname
            : url.host === remote.host &&
                ((hostOnly && !remote.path) ||
                  !url.path ||
                  remote.path === url.path ||
                  remote.path.startsWith(`${url.path}/`));
        })
        .map((login) => [login.name, login]),
    ).values(),
  ];
  return matches.length === 1
    ? matches[0]
    : new Set(matches.map((login) => login.url)).size === 1
      ? matches.find((login) => login.default === "true")
      : undefined;
}
