import Foundation
import CryptoKit
import SQLite3

/// Local originals and the pending note envelope share one durable transaction.
/// Synced images absent on this device are explicit remote references. No image
/// eviction is performed here: task drafts also use this image store.
final class ClientNoteDatabase {
    static let shared: Result<ClientNoteDatabase, Error> = Result {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Friday/Clients", isDirectory: true)
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "Friday", isDirectory: true)
        return try ClientNoteDatabase(url: root.appendingPathComponent("notes.sqlite"))
    }
    private var db: OpaquePointer?
    private let lock = NSRecursiveLock()
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    enum Failure: LocalizedError {
        case storage(String), invalidImage, missingImage
        var errorDescription: String? {
            switch self {
            case .storage(let message): return "本机笔记保存失败：\(message)"
            case .invalidImage: return "图片内容与标识不一致"
            case .missingImage: return "待同步图片在本机不存在，草稿尚未保存，请重新添加图片"
            }
        }
    }
    init(url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            let error = failure(); if let db { sqlite3_close(db) }; db = nil; throw error
        }
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
            #endif
            sqlite3_busy_timeout(db, 5_000)
            try exec("""
                PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY NOT NULL,data BLOB NOT NULL CHECK(length(data)>0));
                CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY CHECK(id=1),data BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS outbox_assets(id TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE RESTRICT);
                CREATE TABLE IF NOT EXISTS outbox_remote_assets(id TEXT PRIMARY KEY NOT NULL);
                """)
        } catch { if let db { sqlite3_close(db) }; db = nil; throw error }
    }
    deinit { if let db { sqlite3_close(db) } }
    private func failure() -> Failure { .storage(db.map { String(cString: sqlite3_errmsg($0)) } ?? "无法打开数据库") }
    private func exec(_ sql: String) throws { guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw failure() } }
    private func statement<T>(_ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        var value: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &value, nil) == SQLITE_OK, let value else { throw failure() }
        defer { sqlite3_finalize(value) }
        return try body(value)
    }
    private func bind(_ text: String, to statement: OpaquePointer, at index: Int32 = 1) throws {
        guard sqlite3_bind_text(statement, index, text, -1, Self.transient) == SQLITE_OK else { throw failure() }
    }
    private func bind(_ data: Data, to statement: OpaquePointer, at index: Int32) throws {
        let result = data.withUnsafeBytes { sqlite3_bind_blob(statement, index, $0.baseAddress, Int32($0.count), Self.transient) }
        guard result == SQLITE_OK else { throw failure() }
    }
    private func done(_ statement: OpaquePointer) throws { guard sqlite3_step(statement) == SQLITE_DONE else { throw failure() } }
    private func bytes(_ statement: OpaquePointer) -> Data {
        guard let pointer = sqlite3_column_blob(statement, 0) else { return Data() }
        return Data(bytes: pointer, count: Int(sqlite3_column_bytes(statement, 0)))
    }
    private func read(_ sql: String, id: String? = nil) throws -> Data? {
        try statement(sql) { statement in
            if let id { try bind(id, to: statement) }
            switch sqlite3_step(statement) { case SQLITE_ROW: return bytes(statement); case SQLITE_DONE: return nil; default: throw failure() }
        }
    }
    func image(_ id: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        return try read("SELECT data FROM assets WHERE id=?", id: id)
    }
    func imageByteCount(_ id: String) throws -> Int? {
        lock.lock(); defer { lock.unlock() }
        return try statement("SELECT length(data) FROM assets WHERE id=?") { statement in
            try bind(id, to: statement)
            switch sqlite3_step(statement) {
            case SQLITE_ROW: return Int(sqlite3_column_int64(statement, 0))
            case SQLITE_DONE: return nil
            default: throw failure()
            }
        }
    }
    func storeImage(_ data: Data, id: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard !data.isEmpty, data.count <= 10 * 1024 * 1024,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == id else { throw Failure.invalidImage }
        try statement("INSERT OR IGNORE INTO assets(id,data) VALUES(?,?)") { statement in
            try bind(id, to: statement); try bind(data, to: statement, at: 2); try done(statement)
        }
    }
    func outbox() throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        return try read("SELECT data FROM outbox WHERE id=1")
    }
    /// The caller imports legacy/local bytes first. A missing new image rejects
    /// the whole envelope; the previously committed draft and pins survive.
    func replaceOutbox(_ data: Data, imageIDs: Set<String>, knownRemoteIDs: Set<String> = []) throws {
        lock.lock(); defer { lock.unlock() }
        try exec("BEGIN IMMEDIATE")
        do {
            var remote = knownRemoteIDs
            try statement("SELECT id FROM outbox_remote_assets") { statement in
                var result = sqlite3_step(statement)
                while result == SQLITE_ROW {
                    if let value = sqlite3_column_text(statement, 0) { remote.insert(String(cString: value)) }
                    result = sqlite3_step(statement)
                }
                guard result == SQLITE_DONE else { throw failure() }
            }
            try exec("DELETE FROM outbox_assets; DELETE FROM outbox_remote_assets")
            for id in imageIDs {
                let local = try statement("SELECT 1 FROM assets WHERE id=?") { statement in
                    try bind(id, to: statement)
                    switch sqlite3_step(statement) { case SQLITE_ROW: return true; case SQLITE_DONE: return false; default: throw failure() }
                }
                guard local || remote.contains(id) else { throw Failure.missingImage }
                try statement(local ? "INSERT INTO outbox_assets(id) VALUES(?)" : "INSERT INTO outbox_remote_assets(id) VALUES(?)") { statement in
                    try bind(id, to: statement); try done(statement)
                }
            }
            try statement("INSERT INTO outbox(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data") { statement in
                try bind(data, to: statement, at: 1); try done(statement)
            }
            try exec("COMMIT")
        } catch { try? exec("ROLLBACK"); throw error }
    }
}
