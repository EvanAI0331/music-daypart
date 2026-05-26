import Foundation
import CoreAudio

func getProperty<T>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain, as type: T.Type) -> T? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    var value = unsafeBitCast(0, to: T.self)
    var size = UInt32(MemoryLayout<T>.size)
    let status = AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

func getString(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    guard let cf: CFString = getProperty(objectID, selector, as: CFString.self) else { return "" }
    return cf as String
}

func getDeviceIDs() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = Array(repeating: AudioObjectID(0), count: count)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
    return ids
}

func getSubDeviceUIDs(_ objectID: AudioObjectID) -> [String] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioAggregateDevicePropertyFullSubDeviceList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(objectID, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = Array(repeating: AudioObjectID(0), count: count)
    guard AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.map { getString($0, kAudioDevicePropertyDeviceUID) }
}

for id in getDeviceIDs() {
    let name = getString(id, kAudioObjectPropertyName)
    let uid = getString(id, kAudioDevicePropertyDeviceUID)
    let model = getString(id, kAudioDevicePropertyModelUID)
    let subUIDs = getSubDeviceUIDs(id)
    print("\(id)\t\(name)\t\(uid)\t\(model)\t\(subUIDs.joined(separator: ","))")
}
