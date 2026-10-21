import Foundation
@preconcurrency import AVFoundation

enum TaskBrowserRecordingRecovery {
    static func recover(_ original:TaskBrowserArtifact,store:TaskBrowserArtifactStore) async throws->TaskBrowserArtifact {
        let source=try store.url(original),folder=source.deletingLastPathComponent(),lease=try TaskBrowserRecordingLease(folder:folder)
        return try await withExtendedLifetimeAsync(lease) {
            let metadata=folder.appendingPathComponent("metadata.json")
            if (try? FileManager.default.destinationOfSymbolicLink(atPath:metadata.path))==nil,
               let data=try? Data(contentsOf:metadata),data.count<8192,
               let committed=try? JSONDecoder().decode(TaskBrowserArtifact.self,from:data),committed.id==original.id,committed.recording {
                _=try await duration(store.url(committed));return committed
            }
            var recovered=original;recovered=TaskBrowserArtifact(id:original.id,name:"recovered-"+original.name,recording:true,createdAt:original.createdAt,recovered:true)
            let destination=try store.url(recovered)
            if FileManager.default.fileExists(atPath:destination.path) {
                if (try? await duration(destination)) != nil {try store.commit(recovered);return recovered}
                // Only this deterministic private output is replaceable; the original is retained.
                try FileManager.default.removeItem(at:destination)
            }
            _=try await duration(source)
            let asset=AVURLAsset(url:source,options:[AVURLAssetPreferPreciseDurationAndTimingKey:true,AVURLAssetReferenceRestrictionsKey:AVAssetReferenceRestrictions.forbidAll.rawValue])
            guard let export=AVAssetExportSession(asset:asset,presetName:AVAssetExportPresetPassthrough) else{throw ConnectionError.message("无法恢复这段录屏，原始文件已保留")}
            export.outputURL=destination;export.outputFileType = .mp4;export.shouldOptimizeForNetworkUse=true
            try await withCheckedThrowingContinuation {(continuation:CheckedContinuation<Void,Error>) in
                let reply=TaskBrowserCaptureReply(continuation,timeout:60)
                export.exportAsynchronously {
                    defer {withExtendedLifetime(lease) {}}
                    if export.status == .completed {reply.finish(.success(()))}else{reply.finish(.failure(export.error ?? ConnectionError.message("无法恢复这段录屏，原始文件已保留")))}
                }
            }
            _=try await duration(destination);try store.commit(recovered);return recovered
        }
    }
    static func duration(_ url:URL) async throws->Double {
        let asset=AVURLAsset(url:url,options:[AVURLAssetPreferPreciseDurationAndTimingKey:true,AVURLAssetReferenceRestrictionsKey:AVAssetReferenceRestrictions.forbidAll.rawValue])
        let time=try await asset.load(.duration),tracks=try await asset.loadTracks(withMediaType:.video)
        let seconds=CMTimeGetSeconds(time)
        guard seconds.isFinite,seconds>0,!tracks.isEmpty else{throw ConnectionError.message("尚无可恢复的完整片段，原始文件已保留")};return seconds
    }
    private static func withExtendedLifetimeAsync<T>(_ lease:TaskBrowserRecordingLease,operation:() async throws->T) async rethrows->T {
        defer {withExtendedLifetime(lease) {}};return try await operation()
    }
}

extension TaskBrowserCaptureOwner {
    func refreshInterruptedRecordings() {
        interruptedArtifacts=(try? TaskBrowserArtifactStore(scope:artifactScope).interrupted()) ?? []
    }
    func recoverRecording(_ artifact:TaskBrowserArtifact) {
        guard !captureClosed,!TaskBrowserCaptureRegistry.shared.terminating,!recoveringArtifacts.contains(artifact.id) else{return}
        recoveringArtifacts.insert(artifact.id);let operationID=UUID()
        let work=Task {
            defer {recoveringArtifacts.remove(artifact.id);refreshInterruptedRecordings();TaskBrowserCaptureRegistry.shared.remove(operationID)}
            do {let store=try TaskBrowserArtifactStore(scope:artifactScope),result=try await TaskBrowserRecordingRecovery.recover(artifact,store:store);publish(result,store:store)}
            catch {if !captureClosed {message=error.localizedDescription};throw error}
        }
        TaskBrowserCaptureRegistry.shared.register(id:operationID,wait:{try await work.value})
    }
}
