// 图片文字识别小工具（macOS Vision 框架）—— 被 src/modules/notes/ocr.js 首次使用时编译并复用。
//
// 设计约定（改这个文件前先看这几条）：
//   1. 只做一件事：读一张本地图片 → 把每行识别结果以 JSON 打到 stdout。
//      不做批处理、不写文件、不联网；图片数据不离开本机（隐私要求）。
//   2. stdout 一行一个 JSON 对象：{"text":"...","confidence":0.98}。
//      出错打到 stderr 并以非 0 退出，调用方据此区分"没字"和"坏了"。
//   3. 语言默认简体中文 + 英文，`--languages` 可覆盖（见 ocr.js 的 DEFAULT_LANGUAGES）。
//
// 编译：/usr/bin/swiftc -O -module-cache-path <cache> vision-ocr.swift -o vision-ocr
import Foundation
import AppKit
import Vision

/// 打印一行 JSON（手写序列化，避免 Codable 在旧 SDK 上的兼容问题）。
func emit(text: String, confidence: Float) {
    let escaped = text
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\t", with: "\\t")
    let value = confidence.isFinite ? confidence : 0
    print("{\"text\":\"\(escaped)\",\"confidence\":\(value)}")
}

// 命令行参数：第一个非选项参数是图片路径；"--languages" 后面可以跟多个语言代码。
let arguments = Array(CommandLine.arguments.dropFirst())
var imagePath: String? = nil
var languages: [String] = []
var index = 0
while index < arguments.count {
    let argument = arguments[index]
    if argument == "--languages" {
        index += 1
        while index < arguments.count && !arguments[index].hasPrefix("--") {
            languages.append(arguments[index])
            index += 1
        }
        continue
    }
    if imagePath == nil { imagePath = argument }
    index += 1
}

guard let path = imagePath else {
    FileHandle.standardError.write("用法：vision-ocr <图片路径> [--languages zh-Hans en-US]\n".data(using: .utf8)!)
    exit(2)
}
guard let image = NSImage(contentsOfFile: path), let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("无法读取图片：\(path)\n".data(using: .utf8)!)
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
if !languages.isEmpty { request.recognitionLanguages = languages }
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("识别失败：\(error.localizedDescription)\n".data(using: .utf8)!)
    exit(4)
}

// `.accurate` 的识别结果里 observe 的文字顺序不保证是阅读顺序，按 y 从大到小、x 从小到大排一次。
let observations = (request.results ?? []).sorted { left, right in
    let dy = left.boundingBox.midY - right.boundingBox.midY
    return abs(dy) > 0.01 ? dy > 0 : left.boundingBox.minX < right.boundingBox.minX
}

var printed = 0
for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { continue }
    emit(text: text, confidence: candidate.confidence)
    printed += 1
}

exit(printed > 0 ? 0 : 1)
