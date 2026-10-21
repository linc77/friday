import Foundation
@main struct ManagedProjectNamingTests {
    struct Fixture: Decodable { let source: String; let cases: [Case] }
    struct Case: Decodable { let name: String; let folder: String }
    struct CloneFixture: Decodable { let source: String; let remotes: [Remote] }
    struct Remote: Decodable { let remote: String; let normalized: String; let publicRemote: String; let directoryName: String }
    static func main() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        precondition(fixture.source == "8cd9641f76874f2ce17d6c80acd71fab1f0b99d3")
        for value in fixture.cases { precondition(ManagedProjectNaming.folderName(value.name) == value.folder, "T3 folder preview mismatch: \(value.name)") }
        print("\(fixture.cases.count) independent T3 project path previews passed")
        if CommandLine.arguments.count > 2 {
            let clones = try JSONDecoder().decode(CloneFixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
            precondition(clones.source == fixture.source)
            for value in clones.remotes {
                precondition(ManagedProjectNaming.normalizeCloneRemote(value.remote) == value.normalized)
                precondition(ManagedProjectNaming.cloneDirectoryName(value.normalized) == value.directoryName)
                precondition(ManagedProjectNaming.publicCloneRemote(value.normalized) == value.publicRemote)
            }
            print("\(clones.remotes.count) independent T3 clone URL and directory previews passed")
        }
    }
}
