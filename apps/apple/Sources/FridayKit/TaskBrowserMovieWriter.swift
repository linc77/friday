import Foundation
import AVFoundation
import CoreGraphics

/// AVAssetWriter and its buffers are confined to one queue. No frame-sized array is accumulated.
final class TaskBrowserMovieWriter:@unchecked Sendable {
    private let queue=DispatchQueue(label:"friday.browser.movie-writer",qos:.userInitiated)
    private let writer:AVAssetWriter
    private let input:AVAssetWriterInput
    private let adaptor:AVAssetWriterInputPixelBufferAdaptor
    private let lease:TaskBrowserRecordingLease?
    let size:CGSize
    private let frameRate:Int
    private var lastTime:CMTime?
    private var lastImage:CGImage?
    private var lastDecoration:TaskBrowserRecordingDecorations?
    private var lastNow=0.0
    private var finished=false
    private(set) var frames=0
    init(url:URL,imageSize:CGSize,frameRate:Int,lease:TaskBrowserRecordingLease?=nil)throws {
        self.lease=lease;self.frameRate=frameRate
        size=TaskBrowserCapturePolicy.videoSize(imageSize);writer=try AVAssetWriter(outputURL:url,fileType:.mp4)
        writer.movieFragmentInterval=CMTime(seconds:2,preferredTimescale:600)
        input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:Int(size.width),AVVideoHeightKey:Int(size.height),AVVideoColorPropertiesKey:[AVVideoColorPrimariesKey:AVVideoColorPrimaries_ITU_R_709_2,AVVideoTransferFunctionKey:AVVideoTransferFunction_ITU_R_709_2,AVVideoYCbCrMatrixKey:AVVideoYCbCrMatrix_ITU_R_709_2],AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:TaskBrowserCapturePolicy.bitRate(width:Int(size.width),height:Int(size.height),frameRate:frameRate),AVVideoExpectedSourceFrameRateKey:frameRate,AVVideoMaxKeyFrameIntervalKey:frameRate*2,AVVideoAllowFrameReorderingKey:false]])
        input.expectsMediaDataInRealTime=true
        adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:Int(size.width),kCVPixelBufferHeightKey as String:Int(size.height),kCVPixelBufferCGImageCompatibilityKey as String:true,kCVPixelBufferCGBitmapContextCompatibilityKey as String:true])
        guard writer.canAdd(input) else{throw ConnectionError.message("无法创建网页录屏")};writer.add(input)
        guard writer.startWriting() else{throw writer.error ?? ConnectionError.message("无法创建网页录屏")};writer.startSession(atSourceTime:.zero)
    }
    func append(_ image:CGImage,seconds:Double,decoration:TaskBrowserRecordingDecorations?=nil,now:Double=0) async throws->Bool {
        try await withCheckedThrowingContinuation {(continuation:CheckedContinuation<Bool,Error>) in
            let reply=TaskBrowserCaptureReply(continuation,timeout:8)
            queue.async {do {reply.finish(.success(try self.appendLocked(image,seconds:seconds,decoration:decoration,now:now)))}catch{reply.finish(.failure(error))}}
        }
    }
    private func appendLocked(_ image:CGImage,seconds:Double,decoration:TaskBrowserRecordingDecorations?=nil,now:Double=0)throws->Bool {
        guard !finished,writer.status == .writing else{throw writer.error ?? ConnectionError.message("网页录屏已结束")}
        guard input.isReadyForMoreMediaData,seconds.isFinite,seconds>=0 else{return false}
        let time=lastTime==nil ? CMTime.zero:CMTime(seconds:seconds,preferredTimescale:60_000);if let lastTime,time<=lastTime {return false}
        var buffer:CVPixelBuffer?
        let result=adaptor.pixelBufferPool.map {CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault,$0,&buffer)} ?? CVPixelBufferCreate(kCFAllocatorDefault,Int(size.width),Int(size.height),kCVPixelFormatType_32BGRA,[kCVPixelBufferCGImageCompatibilityKey:true,kCVPixelBufferCGBitmapContextCompatibilityKey:true] as CFDictionary,&buffer)
        guard result==kCVReturnSuccess,let buffer else{throw ConnectionError.message("无法编码网页录屏")}
        CVPixelBufferLockBaseAddress(buffer,[]);defer {CVPixelBufferUnlockBaseAddress(buffer,[])}
        let space=CGColorSpace(name:CGColorSpace.sRGB)!
        CVBufferSetAttachment(buffer,kCVImageBufferCGColorSpaceKey,space,.shouldPropagate)
        CVBufferSetAttachment(buffer,kCVImageBufferColorPrimariesKey,kCVImageBufferColorPrimaries_ITU_R_709_2,.shouldPropagate)
        CVBufferSetAttachment(buffer,kCVImageBufferTransferFunctionKey,kCVImageBufferTransferFunction_ITU_R_709_2,.shouldPropagate)
        CVBufferSetAttachment(buffer,kCVImageBufferYCbCrMatrixKey,kCVImageBufferYCbCrMatrix_ITU_R_709_2,.shouldPropagate)
        guard let context=CGContext(data:CVPixelBufferGetBaseAddress(buffer),width:Int(size.width),height:Int(size.height),bitsPerComponent:8,bytesPerRow:CVPixelBufferGetBytesPerRow(buffer),space:space,bitmapInfo:CGImageAlphaInfo.premultipliedFirst.rawValue|CGBitmapInfo.byteOrder32Little.rawValue) else{throw ConnectionError.message("无法编码网页录屏")}
        context.setFillColor(CGColor(gray:0,alpha:1));context.fill(CGRect(origin:.zero,size:size))
        let scale=min(size.width/Double(image.width),size.height/Double(image.height)),rect=CGRect(x:(size.width-Double(image.width)*scale)/2,y:(size.height-Double(image.height)*scale)/2,width:Double(image.width)*scale,height:Double(image.height)*scale)
        context.interpolationQuality = .high;context.draw(image,in:rect)
        decoration?.draw(in:context,rect:rect,now:now)
        var format:CMVideoFormatDescription?,sample:CMSampleBuffer?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator:kCFAllocatorDefault,imageBuffer:buffer,formatDescriptionOut:&format)==noErr,let format else{throw ConnectionError.message("无法编码网页录屏")}
        var timing=CMSampleTimingInfo(duration:CMTime(value:1,timescale:CMTimeScale(frameRate)),presentationTimeStamp:time,decodeTimeStamp:.invalid)
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator:kCFAllocatorDefault,imageBuffer:buffer,formatDescription:format,sampleTiming:&timing,sampleBufferOut:&sample)==noErr,let sample,input.append(sample) else{throw writer.error ?? ConnectionError.message("无法编码网页录屏")}
        lastTime=time;lastImage=image;lastDecoration=decoration;lastNow=now;frames+=1;return true
    }
    func finish(seconds:Double) async throws {
        try await withCheckedThrowingContinuation {(continuation:CheckedContinuation<Void,Error>) in
            let reply=TaskBrowserCaptureReply(continuation)
            queue.async {
            guard !self.finished,self.frames>0 else{reply.finish(.failure(ConnectionError.message("录屏尚未取得画面")));return}
            let end=max(seconds,(self.lastTime.map {CMTimeGetSeconds($0)} ?? 0)+1/Double(self.frameRate))
            let endNow=self.lastNow+max(0,end-(self.lastTime.map {CMTimeGetSeconds($0)} ?? 0))
            do {if let image=self.lastImage { _=try self.appendLocked(image,seconds:max(0,end-1/Double(self.frameRate)),decoration:self.lastDecoration,now:endNow) }}catch{self.writer.cancelWriting();self.finished=true;reply.finish(.failure(error));return}
            self.finished=true;self.lastImage=nil;self.input.markAsFinished()
            self.writer.finishWriting {if self.writer.status == .completed {reply.finish(.success(()))}else{reply.finish(.failure(self.writer.error ?? ConnectionError.message("录屏保存失败")))}}
        }}
    }
    func cancel() {queue.async {self.finished=true;self.lastImage=nil;if self.writer.status == .writing || self.writer.status == .unknown {self.writer.cancelWriting()}}}
}
