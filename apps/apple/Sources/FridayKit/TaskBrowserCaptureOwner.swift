import SwiftUI
import CoreGraphics

@MainActor protocol TaskBrowserCaptureOwner:AnyObject,ObservableObject {
    var captureClosed:Bool {get}
    var captureAvailable:Bool {get}
    var captureURL:String? {get}
    var captureDocument:String {get}
    var artifactScope:String {get}
    var frames:TaskBrowserFrames {get}
    var capturing:Bool {get set}
    var message:String? {get set}
    var exported:TaskBrowserExport? {get set}
    var recordingSession:TaskBrowserRecordingSession? {get set}
    var capturedArtifact:TaskBrowserArtifact? {get set}
    var artifacts:[TaskBrowserArtifact] {get set}
    var interruptedArtifacts:[TaskBrowserArtifact] {get set}
    var recoveringArtifacts:Set<String> {get set}
    func captureImage()async throws->CGImage
    func prepareRecording(nonce:String,showKeys:Bool)async throws
    func finishRecordingInput(nonce:String)async
    func recordingDidFinish()
    func capture()
    func startRecording(frameRate:Int)
    func publish(_ artifact:TaskBrowserArtifact,store:TaskBrowserArtifactStore)
    func artifactURL(_ artifact:TaskBrowserArtifact)throws->URL
    func copyArtifact(_ artifact:TaskBrowserArtifact,image:Bool)
    func exportArtifact(_ artifact:TaskBrowserArtifact)
    func refreshInterruptedRecordings()
    func recoverRecording(_ artifact:TaskBrowserArtifact)
    #if os(macOS)
    func revealArtifact(_ artifact:TaskBrowserArtifact)
    #endif
}
extension TaskBrowserController:TaskBrowserCaptureOwner {
    var captureClosed:Bool {closed}
    var captureAvailable:Bool {!closed && url != nil}
    var captureURL:String? {url}
    var captureDocument:String {documentID.uuidString}
    func captureImage()async throws->CGImage {try await frames.capture()}
    func prepareRecording(nonce:String,showKeys:Bool)async throws {annotationSession?.cancel()}
    func finishRecordingInput(nonce:String)async {}
    func recordingDidFinish() {
        #if os(macOS)
        releaseRetainedWindowIfUnused()
        #endif
    }
}
