import UIKit
import Social
import UniformTypeIdentifiers

final class ShareViewController: SLComposeServiceViewController {
    private var attachments: [String] = []
    private var loading = true
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "保存到 Friday"
        navigationController?.navigationBar.topItem?.rightBarButtonItem?.title = "保存"
        Task { @MainActor in
            for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
                for provider in item.attachments ?? [] {
                    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL { attachments.append(url.absoluteString) }
                    else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String { attachments.append(text) }
                }
            }
            loading = false; validateContent()
        }
    }
    private var ideaText: String {
        ([contentText ?? ""] + attachments).filter { !$0.isEmpty }.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    override func isContentValid() -> Bool { !loading && !ideaText.isEmpty && ideaText.utf16.count <= 12_000 }
    override func didSelectPost() {
        do {
            guard let group = Bundle.main.object(forInfoDictionaryKey: "FridayAppGroup") as? String,
                  let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
                throw NSError(domain: "Friday", code: 1, userInfo: [NSLocalizedDescriptionKey: "请先为 App 与分享扩展配置相同的 App Group。"])
            }
            let id = UUID().uuidString
            let directory = root.appendingPathComponent("Ideas", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: ["id": id, "text": ideaText])
            try data.write(to: directory.appendingPathComponent(id + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        } catch {
            let alert = UIAlertController(title: "还没有保存成功", message: error.localizedDescription, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "知道了", style: .default))
            present(alert, animated: true)
        }
    }
}
