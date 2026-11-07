import SwiftUI

private struct SourceControlSaveAttempt {
    let scope: String
    let owner: UUID
    let id: String
    let body: [String: Any]
}

struct SourceControlSettingsView: View {
    @ObservedObject var store: FridayStore
    @Environment(\.openURL) private var openURL
    @State private var scope = ""
    @State private var loadToken = UUID()
    @State private var settings: SourceControlCredentialSettings?
    @State private var discovery: SourceControlDiscovery?
    @State private var loading = false
    @State private var scanning = false
    @State private var saving = false
    @State private var activeSaveID: String?
    @State private var error: String?
    @State private var pending: SourceControlSaveAttempt?
    @State private var gitlabHost = "gitlab.com"
    @State private var githubHost = "github.com"
    @State private var githubToken = ""
    @State private var accessToken = ""
    @State private var email = ""
    @State private var apiToken = ""
    @State private var gitCafeToken = ""
    @State private var visibleAccounts: Set<String> = []
    @State private var revealsGitHubAccounts = false
    private var locked: Bool { loading || saving || pending != nil || !store.connected || scope != store.connectionIdentity }
    private var savedGitHubToken: Bool { settings?.githubTokens.contains { $0.host == githubHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() } == true }

    var body: some View {
        SettingsPage(title: "Source Control", subtitle: "管理服务主机的仓库平台、登录状态和发布凭据。") {
            SourceControlMergeSettings(store: store)
            HStack {
                Text(friday: "平台状态").font(.headline)
                Spacer()
                Button(friday: scanning ? "正在扫描" : "重新扫描", systemImage: "arrow.clockwise") { Task { await scan() } }
                    .buttonStyle(FridayButtonStyle(compact: true)).disabled(scanning || locked)
            }
            if let discovery {
                SettingsGroup("仓库平台") {
                    ForEach(discovery.providers + discovery.githubHosts + (discovery.gitlabHosts ?? [])) { provider in
                        providerRow(provider).padding(16)
                        if provider.id != (discovery.providers + discovery.githubHosts + (discovery.gitlabHosts ?? [])).last?.id { Divider() }
                    }
                }
            } else if scanning || loading { ProgressView().controlSize(.small) }
            if let discovery { githubRouting(discovery) }
            SettingsGroup("GitHub Token") { githubFields.padding(18) }
            SettingsGroup("GitLab") { gitlabFields.padding(18) }
            SettingsGroup("Bitbucket") { bitbucketFields.padding(18) }
            SettingsGroup("GitCafe") { gitCafeFields.padding(18) }
            if let error { Text(fridayString: error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button(friday: "重新载入设置") { Task { await reload() } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(saving || loading || !store.connected)
                if let pending {
                    Button(friday: "重试保存") { send(pending) }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(saving || !store.connected)
                }
                if saving { Text(friday: "正在保存").font(.caption).foregroundStyle(.secondary) }
            }
            Text(friday: "密钥仅保存到服务主机的私有文件；读取设置只返回已配置状态。Git 推送使用主机已有的 SSH／HTTPS 认证。").font(.caption).foregroundStyle(.secondary)
        }
        .task(id: store.connectionIdentity) { await reload() }
        .onChange(of: store.connected) { _, connected in if connected && settings == nil && !loading { Task { await reload() } } }
        .onDisappear { githubToken = ""; accessToken = ""; apiToken = ""; gitCafeToken = ""; pending = nil; revealsGitHubAccounts = false }
    }

    private var githubFields: some View {
        let owner = loadToken
        return VStack(alignment: .leading, spacing: 12) {
            Text(friday: "已保存的 Token 优先于主机环境变量和 gh 登录；发布仓库可直接使用 Token，无需安装 gh。").font(.callout).foregroundStyle(.secondary)
            Text(friday: "Token 和账号路由用于对应 GitHub 主机的 PR 与链接读取；发布新仓库使用 github.com。").font(.caption).foregroundStyle(.secondary)
            TextField(friday: "GitHub 主机", text: scoped($githubHost, owner: owner)).textFieldStyle(.roundedBorder).disabled(locked)
            SecureField(friday: savedGitHubToken ? "已保存，输入以替换" : "GitHub Token", text: scoped($githubToken, owner: owner)).textFieldStyle(.roundedBorder).disabled(locked)
            HStack {
                Button(friday: "保存 Token") { save(["githubToken": ["host": githubHost.trimmingCharacters(in: .whitespacesAndNewlines), "token": githubToken.trimmingCharacters(in: .whitespacesAndNewlines)]], owner: owner) }
                    .buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(locked || githubToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if savedGitHubToken {
                    Button(friday: "移除 Token") { save(["githubToken": ["host": githubHost.trimmingCharacters(in: .whitespacesAndNewlines), "token": ""]], owner: owner) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(locked)
                }
                Button(friday: "创建 Token", systemImage: "arrow.up.right.square") { if owner == loadToken { openTokenPage() } }.buttonStyle(FridaySymbolButtonStyle()).disabled(locked)
            }
            if let settings, !settings.githubTokens.isEmpty {
                Text(friday: "已保存的主机").font(.caption).foregroundStyle(.secondary)
                ForEach(settings.githubTokens) { token in
                    Button { if owner == loadToken { githubHost = token.host; githubToken = "" } } label: { Text(verbatim: token.host).font(.system(.caption, design: .monospaced)) }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(locked)
                }
            }
            Text(verbatim: "gh auth login --hostname github.com").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    private var gitCafeFields: some View {
        let owner = loadToken
        return VStack(alignment: .leading, spacing: 12) {
            SecureField(friday: settings?.gitcafe?.hasToken == true ? "已保存，输入以替换" : "GitCafe Token", text: scoped($gitCafeToken, owner: owner)).textFieldStyle(.roundedBorder).disabled(locked)
            HStack {
                Button(friday: "保存 Token") { save(["gitCafeToken": gitCafeToken.trimmingCharacters(in: .whitespacesAndNewlines)], owner: owner) }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(locked || gitCafeToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if settings?.gitcafe?.hasToken == true { Button(friday: "移除 Token") { save(["gitCafeToken": ""], owner: owner) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(locked) }
            }
            Text(friday: "保存的 Token 用于 git.cafe；也可使用主机的 CAFE_TOKEN 或 cafe 登录。").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var gitlabFields: some View {
        let owner = loadToken
        let hosts = Set((settings?.gitlabHosts ?? []).map(\.host) + (discovery?.gitlabHosts ?? []).map(\.host) + ["gitlab.com"]).sorted()
        return VStack(alignment: .leading, spacing: 12) {
            Text(friday: "添加自建 GitLab 主机；使用服务主机的 glab 登录，并按所选主机读取和发布仓库。").font(.callout).foregroundStyle(.secondary)
            TextField(friday: "GitLab 主机", text: scoped($gitlabHost, owner: owner)).textFieldStyle(.roundedBorder).disabled(locked)
            Text(verbatim: "glab auth login --hostname " + gitlabHost.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            Button(friday: "添加 GitLab 主机") { save(["gitlabHost": ["host": gitlabHost.trimmingCharacters(in: .whitespacesAndNewlines), "enabled": true]], owner: owner) }
                .buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(locked || gitlabHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            ForEach(hosts, id: \.self) { host in
                HStack {
                    Toggle(isOn: Binding(get: { settings?.gitlabHosts?.first(where: { $0.host == host })?.enabled != false }, set: { value in save(["gitlabHost": ["host": host, "enabled": value]], owner: owner) })) { Text(verbatim: host).font(.system(.caption, design: .monospaced)) }.disabled(locked)
                    if host != "gitlab.com", settings?.gitlabHosts?.contains(where: { $0.host == host }) == true {
                        Button(friday: "移除主机") { save(["gitlabHost": ["host": host, "enabled": NSNull()]], owner: owner) }.buttonStyle(FridaySymbolButtonStyle()).disabled(locked)
                    }
                }
            }
            Text(friday: "已通过 glab 登录的主机会自动识别；停用主机会阻止使用该主机的登录凭据。").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var bitbucketFields: some View {
        let owner = loadToken
        return VStack(alignment: .leading, spacing: 12) {
            Text(friday: "使用仓库／项目／工作区 Access Token，或 Atlassian 邮箱与 API Token。Access Token 优先。").font(.callout).foregroundStyle(.secondary)
            SecureField(friday: settings?.bitbucket.hasAccessToken == true ? "Access Token 已保存，输入以替换" : "Access Token", text: scoped($accessToken, owner: owner)).textFieldStyle(.roundedBorder).disabled(locked)
            TextField(friday: "Atlassian 账号邮箱", text: scoped($email, owner: owner)).textFieldStyle(.roundedBorder).disabled(locked)
            SecureField(friday: settings?.bitbucket.hasAPIToken == true ? "API Token 已保存，输入以替换" : "API Token", text: scoped($apiToken, owner: owner)).textFieldStyle(.roundedBorder).disabled(locked)
            VStack(alignment: .leading, spacing: 10) {
                Button(friday: "保存 Bitbucket") {
                    var fields = ["email": email.trimmingCharacters(in: .whitespacesAndNewlines)]
                    if !accessToken.isEmpty { fields["accessToken"] = accessToken.trimmingCharacters(in: .whitespacesAndNewlines) }
                    if !apiToken.isEmpty { fields["apiToken"] = apiToken.trimmingCharacters(in: .whitespacesAndNewlines) }
                    save(["bitbucket": fields], owner: owner)
                }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(locked || accessToken.isEmpty && apiToken.isEmpty && email == (settings?.bitbucket.email ?? ""))
                HStack {
                    if settings?.bitbucket.hasAccessToken == true {
                        Button(friday: "移除 Access Token") { save(["bitbucket": ["accessToken": ""]], owner: owner) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(locked)
                    }
                    if settings?.bitbucket.hasAPIToken == true {
                        Button(friday: "移除 API Token") { save(["bitbucket": ["apiToken": ""]], owner: owner) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(locked)
                    }
                }
            }
            Text(friday: "工作区 Token 可能没有用户读取权限；配置后仍可尝试发布到获授权的工作区。").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func providerRow(_ provider: TaskPublishProvider) -> some View {
        HStack(alignment: .top, spacing: 12) {
            FridaySymbolImage(systemName: provider.status == "ready" ? "checkmark.circle" : "exclamationmark.circle").foregroundStyle(provider.status == "ready" ? Color.secondary : Color.orange).fridaySymbolFeedback(value: provider.status)
            VStack(alignment: .leading, spacing: 5) {
                Text(verbatim: provider.label + " · " + (provider.baseURL ?? provider.host)).font(.callout.weight(.medium))
                Text(fridayString: provider.status == "ready" ? "已认证" : provider.status == "configured" ? "已配置，状态未确认" : provider.status == "missing" ? "主机工具未安装" : "未认证").font(.caption).foregroundStyle(.secondary)
                if let account = provider.account {
                    Button {
                        if visibleAccounts.contains(provider.id) { visibleAccounts.remove(provider.id) } else { visibleAccounts.insert(provider.id) }
                    } label: { Text(verbatim: visibleAccounts.contains(provider.id) ? account : "••••••").font(.caption.monospaced()) }
                        .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "显示或隐藏仓库账号"))
                }
                if let hint = provider.hint { Text(fridayString: hint).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
        }
    }

    private func githubRouting(_ discovery: SourceControlDiscovery) -> some View {
        let hosts = Set(discovery.providers.filter { $0.provider == "github" }.map(\.host) + discovery.githubHosts.map(\.host) + (discovery.githubAccounts ?? []).map(\.host) + (settings?.githubHosts ?? []).map(\.host)).sorted()
        return SettingsGroup("GitHub 账号路由") {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    Text(friday: "为每个主机选择 gh 登录账号，或停用该主机。").font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button(friday: revealsGitHubAccounts ? "隐藏账号" : "显示账号", systemImage: revealsGitHubAccounts ? "eye.slash" : "eye") { revealsGitHubAccounts.toggle() }
                        .buttonStyle(FridaySymbolButtonStyle())
                }
                if let hint = discovery.githubAccountHint { Text(fridayString: hint).font(.caption).foregroundStyle(.secondary) }
                ForEach(hosts, id: \.self) { host in githubHostRow(host, discovery: discovery) }
            }.padding(18)
        }
    }

    private func githubHostRow(_ host: String, discovery: SourceControlDiscovery) -> some View {
        let owner = loadToken
        let choice = settings?.githubHosts?.first { $0.host == host }
        let enabled = choice?.enabled ?? true
        let entries = (discovery.githubAccounts ?? []).filter { $0.host == host }
        let accounts = Set(entries.filter { $0.authenticated && $0.environmentVariable == nil }.map(\.account)).sorted()
        let selected = choice?.account.flatMap { accounts.contains($0) ? $0 : nil } ?? ""
        let provider = (discovery.providers + discovery.githubHosts + (discovery.gitlabHosts ?? [])).first { $0.provider == "github" && $0.host == host }
        return VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(verbatim: host).font(.system(.callout, design: .monospaced))
                Spacer()
                Toggle(isOn: Binding(get: { enabled }, set: { value in save(["githubHost": ["host": host, "enabled": value]], owner: owner) })) { Text(friday: "启用主机") }
                    .labelsHidden().toggleStyle(.switch).disabled(locked).fridayInteractiveCursor().accessibilityLabel(Text(verbatim: host))
            }
            if !accounts.isEmpty {
                Picker(selection: Binding(get: { selected }, set: { account in
                    save(["githubHost": ["host": host, "account": account.isEmpty ? NSNull() : account as Any]], owner: owner)
                })) {
                    Text(friday: "跟随 gh 当前账号").tag("")
                    ForEach(accounts, id: \.self) { account in
                        Text(verbatim: revealsGitHubAccounts ? account : String(repeating: "•", count: max(4, min(account.count, 20)))).tag(account)
                    }
                } label: { Text(friday: "使用账号") }.pickerStyle(.menu).disabled(locked || !enabled).fridayInteractiveCursor()
            } else if discovery.githubAccountHint == nil {
                Text(friday: "登录 gh 后重新扫描，可在此选择账号。").font(.caption).foregroundStyle(.secondary)
            }
            if choice?.account != nil {
                if selected.isEmpty { Text(friday: "已选账号当前不可用，暂时跟随 gh 活跃账号。").font(.caption).foregroundStyle(.orange) }
                Button(friday: "清除账号选择") { save(["githubHost": ["host": host, "account": NSNull()]], owner: owner) }
                    .buttonStyle(FridaySymbolButtonStyle()).font(.caption).disabled(locked)
            }
            if provider?.credentialSource == "settings" || provider?.credentialSource == "environment" {
                Text(friday: "当前使用 Token；Token 不再提供凭据时，gh 账号选择才会生效。").font(.caption).foregroundStyle(.secondary)
            }
            if entries.contains(where: { !$0.authenticated }) {
                Text(friday: "部分 gh 账号登录已失效，请在服务主机重新登录后扫描。").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(12).background(.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 8))
    }

    private func reload() async {
        guard !saving || scope != store.connectionIdentity else { return }
        let identity = store.connectionIdentity; let token = UUID(); scope = identity; loadToken = token
        settings = nil; discovery = nil; error = nil; pending = nil; visibleAccounts = []; revealsGitHubAccounts = false; scanning = false; saving = false; activeSaveID = nil
        githubToken = ""; accessToken = ""; apiToken = ""; gitCafeToken = ""; email = ""; githubHost = "github.com"; gitlabHost = "gitlab.com"
        guard store.connected else { loading = false; return }
        loading = true
        do {
            let value = try await store.sourceControlSettings()
            guard !Task.isCancelled, scope == identity, store.connectionIdentity == identity, loadToken == token else { return }
            settings = value; email = value.bitbucket.email; loading = false
            await scan()
        } catch { if scope == identity && loadToken == token && store.connectionIdentity == identity { self.error = error.localizedDescription; loading = false } }
    }

    private func scan() async {
        guard !scanning, store.connected, scope == store.connectionIdentity else { return }
        let identity = scope; let token = loadToken; scanning = true
        defer { if scope == identity && loadToken == token { scanning = false } }
        do { let value = try await store.sourceControlDiscovery(); if !Task.isCancelled && scope == identity && loadToken == token && store.connectionIdentity == identity { discovery = value; error = nil } }
        catch { if scope == identity && loadToken == token && store.connectionIdentity == identity { self.error = error.localizedDescription } }
    }

    private func save(_ patch: [String: Any], owner: UUID) {
        guard !locked, owner == loadToken, let settings else { return }
        let id = UUID().uuidString
        var body = patch; body["version"] = settings.version; body["requestId"] = id
        let attempt = SourceControlSaveAttempt(scope: scope, owner: owner, id: id, body: body); pending = attempt; send(attempt)
    }
    private func send(_ attempt: SourceControlSaveAttempt) {
        guard !saving, attempt.owner == loadToken, store.connected, attempt.scope == scope, scope == store.connectionIdentity else { return }
        saving = true; activeSaveID = attempt.id; error = nil
        Task {
            defer { if activeSaveID == attempt.id { saving = false; activeSaveID = nil } }
            guard scope == attempt.scope, attempt.owner == loadToken, store.connectionIdentity == attempt.scope else { return }
            do {
                let value = try await store.saveSourceControlSettings(attempt.body)
                guard scope == attempt.scope, attempt.owner == loadToken, store.connectionIdentity == attempt.scope else { return }
                settings = value; email = value.bitbucket.email; githubToken = ""; accessToken = ""; apiToken = ""; gitCafeToken = ""; pending = nil; saving = false; activeSaveID = nil; loadToken = UUID(); scanning = false
                await scan()
            } catch { if scope == attempt.scope && attempt.owner == loadToken && store.connectionIdentity == attempt.scope { self.error = error.localizedDescription } }
        }
    }
    private func scoped(_ value: Binding<String>, owner: UUID) -> Binding<String> {
        Binding(get: { owner == loadToken ? value.wrappedValue : "" }, set: { if owner == loadToken { value.wrappedValue = $0 } })
    }
    private func openTokenPage() {
        let host = githubHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard host.range(of: #"^[a-z0-9][a-z0-9.:-]*$"#, options: .regularExpression) != nil,
              let url = URL(string: "https://" + host + "/settings/personal-access-tokens/new") else { return }
        openURL(url)
    }
}
