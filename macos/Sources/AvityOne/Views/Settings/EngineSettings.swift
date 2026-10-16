import SwiftUI
import AvityKit

struct ConnectionsSettings: View {
  @Environment(AppModel.self) private var app
  @State private var name = ""
  @State private var url = ""
  @State private var token = ""
  @State private var network: JSONValue?
  @State private var showLog = false

  var body: some View {
    Form {
      Section("Ce Mac") {
        LabeledContent("Moteur") {
          HStack {
            Circle().fill(app.isLocal && app.connection == .ready ? Palette.green : .secondary).frame(width: 8, height: 8)
            Text(app.isLocal ? (app.connection == .ready ? "En marche\(app.endpoint.map { " sur 127.0.0.1:\($0.port)" } ?? "")" : "Arrêté") : "Inactif (serveur distant actif)")
          }
        }
        LabeledContent("Données") {
          HStack {
            Text(app.engine.home.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
            Button { OpenIn.reveal(app.engine.home.path) } label: { Image(systemName: "folder") }.buttonStyle(.borderless)
          }
        }
        HStack {
          Button("Redémarrer le moteur") { Task { await app.restartEngine() } }.disabled(!app.isLocal)
          Button("Journal…") { showLog = true }
          if !app.isLocal { Button("Revenir à ce Mac") { Task { await app.switchProfile(ServerProfile.local.id) } } }
        }
        if app.isLocal {
          let https = network?["https"]?.bool == true
          Toggle("Accès HTTPS depuis le téléphone via Tailscale", isOn: Binding(get: { https }, set: { on in
            app.run {
              _ = try await app.client?.post("/network", ["enabled": .bool(on)])
              network = try await app.client?.administration()["network"]
            }
          }))
          .disabled(network?["installed"]?.bool != true)
          Text(network?["installed"]?.bool == true
               ? "`tailscale serve` publie l’interface web du moteur sur ton tailnet\(network?["hostname"]?.string.map { " : https://\($0.hasSuffix(".") ? String($0.dropLast()) : $0)" } ?? "")."
               : "Installe et connecte Tailscale pour utiliser AvityOne depuis ton téléphone (PWA).")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      Section("Serveurs AvityOne distants") {
        ForEach(app.preferences.profiles.filter { !$0.isLocal }) { profile in
          HStack {
            Image(systemName: "server.rack")
            VStack(alignment: .leading) {
              Text(profile.name)
              Text(profile.url).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if profile.id == app.preferences.activeProfileId { Tag(text: "actif", color: Palette.green) }
            else { Button("Se connecter") { Task { await app.switchProfile(profile.id) } } }
            Button(role: .destructive) { remove(profile) } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
          }
        }
        TextField("Nom", text: $name, prompt: Text("Preprod"))
        TextField("Adresse", text: $url, prompt: Text("https://avityone-preprod.tail5feb4c.ts.net"))
        SecureField("Jeton", text: $token, prompt: Text("jq -r .token ~/.avityone/config.json"))
        HStack {
          Spacer()
          Button("Ajouter") { add() }.disabled(name.isEmpty || ServerProfile.normalize(url) == nil || token.isEmpty)
        }
        Text("Les agents travaillent alors sur le serveur, dans ses dossiers. Le jeton est conservé dans le trousseau.").font(.caption).foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
    .sheet(isPresented: $showLog) { EngineLogView() }
    .task { if app.isLocal { network = try? await app.client?.administration()["network"] } }
  }

  private func add() {
    guard let normalized = ServerProfile.normalize(url) else { return }
    let profile = ServerProfile(name: name, kind: .remote, url: normalized.absoluteString)
    Keychain.setToken(token.trimmingCharacters(in: .whitespacesAndNewlines), for: profile.id)
    app.preferences.profiles.append(profile)
    name = ""; url = ""; token = ""
  }

  private func remove(_ profile: ServerProfile) {
    Keychain.removeToken(for: profile.id)
    app.preferences.profiles.removeAll { $0.id == profile.id }
    if profile.id == app.preferences.activeProfileId { Task { await app.switchProfile(ServerProfile.local.id) } }
  }
}

/// Routing rules, reviewers, summaries and parallelism of the engine (config.json, validated by the engine).
struct RoutingSettings: View {
  @Environment(AppModel.self) private var app
  struct Rule: Identifiable, Equatable { let id = UUID(); var match: String; var agent: String; var mode: String }
  @State private var loaded = false
  @State private var agents: [String] = []
  @State private var strategy = "rules"
  @State private var fallback = true
  @State private var routingAgent = ""
  @State private var routingModel = ""
  @State private var defaultAgent = ""
  @State private var reviewer: [String: String] = [:]
  @State private var summarizerAgent = ""
  @State private var summarizerModel = ""
  @State private var summarizeEvery = 4
  @State private var parallel = 4
  @State private var concurrency = 3
  @State private var rules: [Rule] = []

  var body: some View {
    Form {
      if !loaded { ProgressView() } else {
        Section("Choix de l’agent") {
          Picker("Stratégie", selection: $strategy) {
            Text("Règles").tag("rules"); Text("Performances mesurées").tag("performance"); Text("Agent LLM").tag("llm")
          }
          if strategy == "llm" {
            agentPicker("Classifieur", $routingAgent, empty: "Agent du résumeur")
            TextField("Modèle du classifieur", text: $routingModel)
          }
          agentPicker("Agent par défaut", $defaultAgent)
          Toggle("Basculer vers un autre agent si la connexion échoue (avant tout envoi)", isOn: $fallback)
        }
        Section("Règles (la première qui correspond gagne)") {
          ForEach($rules) { $rule in
            HStack {
              TextField("Expression régulière", text: $rule.match).font(.callout.monospaced())
              Picker("", selection: $rule.agent) { ForEach(agents, id: \.self) { Text($0).tag($0) } }.labelsHidden().frame(width: 110)
              Picker("", selection: $rule.mode) { Text("—").tag(""); Text("agent").tag("agent"); Text("plan").tag("plan") }.labelsHidden().frame(width: 80)
              Button { move(rule.id, -1) } label: { Image(systemName: "arrow.up") }.buttonStyle(.borderless)
              Button { rules.removeAll { $0.id == rule.id } } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
            }
          }
          Button { rules.append(Rule(match: "", agent: defaultAgent, mode: "")) } label: { Label("Ajouter une règle", systemImage: "plus") }
        }
        Section("Revue croisée et mémoire") {
          ForEach(agents, id: \.self) { author in
            Picker("Relecteur de \(author)", selection: Binding(get: { reviewer[author] ?? "" }, set: { reviewer[author] = $0 })) {
              ForEach(agents, id: \.self) { Text($0).tag($0) }
            }
          }
          agentPicker("Résumeur", $summarizerAgent)
          TextField("Modèle du résumeur", text: $summarizerModel)
          Stepper("Résumé toutes les \(summarizeEvery) réponses", value: $summarizeEvery, in: 1...100)
        }
        Section("Parallélisme") {
          Stepper("Tâches parallèles par plan : \(parallel)", value: $parallel, in: 1...16)
          Stepper("Requêtes ACP simultanées : \(concurrency)", value: $concurrency, in: 1...32)
        }
        HStack { Spacer(); Button("Enregistrer") { save() }.keyboardShortcut("s") }
      }
    }
    .formStyle(.grouped)
    .task { await load() }
  }

  @ViewBuilder private func agentPicker(_ title: String, _ value: Binding<String>, empty: String? = nil) -> some View {
    Picker(title, selection: value) {
      if let empty { Text(empty).tag("") }
      ForEach(agents, id: \.self) { Text($0).tag($0) }
    }
  }

  private func move(_ id: UUID, _ offset: Int) {
    guard let index = rules.firstIndex(where: { $0.id == id }), rules.indices.contains(index + offset) else { return }
    rules.swapAt(index, index + offset)
  }

  private func load() async {
    guard let config = try? await app.client?.config() else { return }
    agents = (config["agents"]?.object?.keys).map { Array($0).sorted() } ?? []
    strategy = config["routing"]?["strategy"]?.string ?? "rules"
    fallback = config["routing"]?["fallback"]?.bool ?? true
    routingAgent = config["routing"]?["agent"]?.string ?? ""
    routingModel = config["routing"]?["model"]?.string ?? ""
    defaultAgent = config["defaultAgent"]?.string ?? ""
    reviewer = (config["reviewer"]?.object ?? [:]).compactMapValues(\.string)
    summarizerAgent = config["summarizer"]?["agent"]?.string ?? ""
    summarizerModel = config["summarizer"]?["model"]?.string ?? ""
    summarizeEvery = config["summarizeEvery"]?.int ?? 4
    parallel = config["parallel"]?.int ?? 4
    concurrency = config["globalConcurrency"]?.int ?? 3
    rules = (config["routes"]?.array ?? []).map { Rule(match: $0["match"]?.string ?? "", agent: $0["agent"]?.string ?? "", mode: $0["mode"]?.string ?? "") }
    loaded = true
  }

  private func save() {
    let routes: [JSONValue] = rules.filter { !$0.match.isEmpty }.map { rule in
      var value: [String: JSONValue] = ["match": .string(rule.match), "agent": .string(rule.agent)]
      if !rule.mode.isEmpty { value["mode"] = .string(rule.mode) }
      return .object(value)
    }
    var routing: [String: JSONValue] = [:]
    routing["strategy"] = .string(strategy)
    routing["agent"] = .string(routingAgent)
    routing["model"] = .string(routingModel)
    routing["fallback"] = .bool(fallback)
    var summarizer: [String: JSONValue] = [:]
    summarizer["agent"] = .string(summarizerAgent)
    summarizer["model"] = .string(summarizerModel)
    var patch: [String: JSONValue] = [:]
    patch["routing"] = .object(routing)
    patch["defaultAgent"] = .string(defaultAgent)
    patch["reviewer"] = .object(reviewer.mapValues { JSONValue.string($0) })
    patch["summarizer"] = .object(summarizer)
    patch["summarizeEvery"] = .number(Double(summarizeEvery))
    patch["parallel"] = .number(Double(parallel))
    patch["globalConcurrency"] = .number(Double(concurrency))
    patch["routes"] = .array(routes)
    app.run {
      _ = try await app.client?.updateConfig(.object(patch))
      app.toast("Routage enregistré.")
      await load()
    }
  }
}

/// Extra stdio MCP servers given to every agent, next to AvityOne's own memory server.
struct McpSettings: View {
  @Environment(AppModel.self) private var app
  struct Server: Identifiable, Equatable { let id = UUID(); var name: String; var command: String; var args: String; var env: String; var enabled: Bool }
  @State private var servers: [Server] = []
  @State private var loaded = false

  var body: some View {
    Form {
      Section {
        ForEach($servers) { $server in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Toggle("", isOn: $server.enabled).labelsHidden()
              TextField("Nom", text: $server.name).frame(width: 140)
              TextField("Commande", text: $server.command).font(.callout.monospaced())
              Button { servers.removeAll { $0.id == server.id } } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
            }
            TextField("Arguments, un par ligne", text: $server.args, axis: .vertical).lineLimit(1...4).font(.caption.monospaced())
            TextField("Variables CLÉ=valeur, une par ligne (••••••  conserve un secret)", text: $server.env, axis: .vertical).lineLimit(1...4).font(.caption.monospaced())
          }
          .padding(.vertical, 4)
        }
        Button { servers.append(Server(name: "", command: "", args: "", env: "", enabled: true)) } label: { Label("Ajouter un serveur", systemImage: "plus") }
      } header: { Text("Serveurs MCP stdio") } footer: {
        Text("Exemples : Serena (`uvx --from git+https://github.com/oraios/serena serena start-mcp-server`), Context7 (`npx -y @upstash/context7-mcp`). Ils doivent être installés sur la machine du moteur.")
          .font(.caption).foregroundStyle(.secondary)
      }
      HStack { Spacer(); Button("Enregistrer") { save() }.disabled(!loaded) }
    }
    .formStyle(.grouped)
    .task { await load() }
  }

  private func load() async {
    guard let config = try? await app.client?.config() else { return }
    servers = (config["mcpServers"]?.array ?? []).map { s in
      Server(name: s["name"]?.string ?? "", command: s["command"]?.string ?? "",
             args: (s["args"]?.array ?? []).compactMap(\.string).joined(separator: "\n"),
             env: (s["env"]?.object ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.string ?? "")" }.joined(separator: "\n"),
             enabled: s["enabled"]?.bool ?? true)
    }
    loaded = true
  }

  private func save() {
    let list: [JSONValue] = servers.filter { !$0.name.isEmpty }.map { s in
      let args = s.args.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
      var env: [String: JSONValue] = [:]
      for line in s.env.split(separator: "\n") {
        guard let eq = line.firstIndex(of: "=") else { continue }
        env[String(line[..<eq]).trimmingCharacters(in: .whitespaces)] = .string(String(line[line.index(after: eq)...]))
      }
      var server: [String: JSONValue] = [:]
      server["name"] = .string(s.name)
      server["command"] = .string(s.command)
      server["args"] = .strings(args)
      server["env"] = .object(env)
      server["enabled"] = .bool(s.enabled)
      return .object(server)
    }
    app.run {
      _ = try await app.client?.updateConfig(["mcpServers": .array(list)])
      app.toast("Serveurs MCP enregistrés : ils s’appliquent aux prochaines connexions d’agents.")
      await load()
    }
  }
}

/// The whole engine configuration as JSON, backups, access token and usage.
struct AdvancedSettings: View {
  @Environment(AppModel.self) private var app
  @State private var base: JSONValue?
  @State private var text = ""
  @State private var conflict = false
  @State private var admin: JSONValue?
  @State private var showUsage = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        GroupBox {
          VStack(alignment: .leading, spacing: 8) {
            Text("Budgets, délais, validations, préparation des worktrees, transcription, agents et quotas. Les secrets restent masqués (••••••) et sont conservés tels quels.")
              .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $text).font(.system(size: 11, design: .monospaced)).frame(height: 240).scrollContentBackground(.hidden).background(Palette.codeBackground)
            if conflict {
              HStack {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.amber)
                Text("La configuration a changé ailleurs depuis l’ouverture. Ton brouillon est conservé.").font(.caption)
                Button("Reprendre la version enregistrée") { Task { await load() } }
              }
            }
            HStack {
              Spacer()
              Button("Annuler les modifications") { text = base?.pretty() ?? "" }.disabled(text == (base?.pretty() ?? ""))
              Button("Enregistrer") { save() }.disabled(text == (base?.pretty() ?? ""))
            }
          }
        } label: { Label("Configuration du moteur", systemImage: "curlybraces") }

        GroupBox {
          VStack(alignment: .leading, spacing: 8) {
            Text("Base SQLite et pièces jointes. Les dossiers des projets et la configuration contenant les accès se sauvegardent séparément.").font(.caption).foregroundStyle(.secondary)
            Button("Créer une sauvegarde") { app.run { _ = try await app.client?.post("/backups"); await loadAdmin() } }
            ForEach(admin?["backups"]?.array ?? [], id: \.self) { backup in
              HStack {
                Text(backup["createdAt"]?.string ?? backup["id"]?.string ?? "").font(.callout.monospaced())
                Spacer()
                Button("Restaurer…") { restore(backup["id"]?.string ?? "") }
              }
            }
          }
        } label: { Label("Sauvegardes", systemImage: "externaldrive") }

        GroupBox {
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Button("Copier le jeton d’accès") { copyToPasteboard(app.client?.token ?? ""); app.toast("Jeton copié.") }
              Button("Changer le jeton d’accès") { rotate() }
            }
            Text("Révoque les autres accès (navigateurs, CLI, téléphones) : ils devront se reconnecter.").font(.caption).foregroundStyle(.secondary)
            DisclosureGroup("Usage, budgets et quotas", isExpanded: $showUsage) {
              Text(admin?["usage"]?.pretty() ?? "").font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        } label: { Label("Accès et usage", systemImage: "key") }
      }
      .padding(18)
    }
    .task { await load(); await loadAdmin() }
  }

  private func load() async {
    guard let config = try? await app.client?.config() else { return }
    base = config
    text = config.pretty()
    conflict = false
  }

  private func loadAdmin() async { admin = try? await app.client?.administration() }

  private func save() {
    guard let base, let edited = try? JSONValue.parse(text), let editedObject = edited.object, let baseObject = base.object else {
      app.toast("JSON invalide.", error: true); return
    }
    app.run {
      guard let client = app.client else { return }
      if try await client.config() != base { conflict = true; return }
      var patch: [String: JSONValue] = [:]
      for (key, value) in editedObject where baseObject[key] != value { patch[key] = value }
      guard !patch.isEmpty else { return }
      _ = try await client.updateConfig(.object(patch))
      app.toast("Configuration enregistrée. Une adresse ou un port modifié s’applique au redémarrage.")
      await load()
    }
  }

  private func restore(_ id: String) {
    let alert = NSAlert()
    alert.messageText = "Restaurer cette sauvegarde ?"
    alert.informativeText = "Les sessions doivent être arrêtées. Une copie de sécurité est créée, puis le moteur redémarre."
    alert.addButton(withTitle: "Restaurer")
    alert.addButton(withTitle: "Annuler")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    app.run {
      _ = try await app.client?.post("/backups/\(id)/restore")
      app.toast("Sauvegarde restaurée : redémarrage du moteur.")
      await app.restartEngine()
    }
  }

  private func rotate() {
    app.run {
      guard let client = app.client else { return }
      let token = try await client.rotateToken()
      if !app.isLocal { Keychain.setToken(token, for: app.preferences.activeProfileId) }
      app.toast("Nouveau jeton actif.")
    }
  }
}
