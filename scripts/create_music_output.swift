import Foundation
import CoreAudio

let aggregateName = "Music Project Speakers"
let aggregateUID = "com.local.music-project.soundpro-2615-2872"
let targetUIDs = [
    "4C-C6-4C-39-1B-D8:output",
    "4C-C6-4C-39-1C-D9:output"
]

func osStatusString(_ status: OSStatus) -> String {
    if status == noErr { return "noErr" }
    let n = UInt32(bitPattern: status).bigEndian
    let chars = [
        Character(UnicodeScalar((n >> 24) & 255)!),
        Character(UnicodeScalar((n >> 16) & 255)!),
        Character(UnicodeScalar((n >> 8) & 255)!),
        Character(UnicodeScalar(n & 255)!)
    ]
    let text = String(chars)
    if text.unicodeScalars.allSatisfy({ !$0.properties.isASCIIHexDigit || !$0.properties.isWhitespace }) {
        return "\(status) (\(text))"
    }
    return "\(status)"
}

func getDeviceIDs() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = Array(repeating: AudioObjectID(0), count: Int(size) / MemoryLayout<AudioObjectID>.size)
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
    return ids
}

func getCFString(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value)
    return status == noErr ? value as String : ""
}

func deviceID(uid: String) -> AudioObjectID? {
    getDeviceIDs().first { getCFString($0, kAudioDevicePropertyDeviceUID) == uid }
}

func destroyExistingAggregate() {
    for id in getDeviceIDs() where getCFString(id, kAudioDevicePropertyDeviceUID) == aggregateUID {
        let status = AudioHardwareDestroyAggregateDevice(id)
        if status != noErr {
            fputs("Failed to destroy existing aggregate: \(osStatusString(status))\n", stderr)
            exit(1)
        }
    }
}

let missing = targetUIDs.filter { deviceID(uid: $0) == nil }
if !missing.isEmpty {
    fputs("Missing target audio devices: \(missing.joined(separator: ", "))\n", stderr)
    exit(2)
}

destroyExistingAggregate()

let subDevices: [[String: Any]] = targetUIDs.enumerated().map { index, uid in
    [
        kAudioSubDeviceUIDKey: uid,
        kAudioSubDeviceDriftCompensationKey: index == 0 ? 0 : 1,
        kAudioSubDeviceDriftCompensationQualityKey: kAudioAggregateDriftCompensationHighQuality
    ]
}

let description: [String: Any] = [
    kAudioAggregateDeviceNameKey: aggregateName,
    kAudioAggregateDeviceUIDKey: aggregateUID,
    kAudioAggregateDeviceSubDeviceListKey: subDevices,
    kAudioAggregateDeviceMainSubDeviceKey: targetUIDs[0],
    kAudioAggregateDeviceClockDeviceKey: targetUIDs[0],
    kAudioAggregateDeviceIsPrivateKey: 0,
    kAudioAggregateDeviceIsStackedKey: 1
]

var aggregateID = AudioObjectID(0)
let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateID)
if status != noErr {
    fputs("Failed to create aggregate: \(osStatusString(status))\n", stderr)
    exit(3)
}

print("created\t\(aggregateID)\t\(aggregateName)\t\(aggregateUID)")
