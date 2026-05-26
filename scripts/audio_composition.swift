import Foundation
import CoreAudio

func deviceIDs() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    var ids = Array(repeating: AudioObjectID(0), count: Int(size) / MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
    return ids
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    if AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr {
        return value as String
    }
    return ""
}

func composition(_ id: AudioObjectID) -> Any? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioAggregateDevicePropertyComposition, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: CFPropertyList?
    var size = UInt32(MemoryLayout<CFPropertyList?>.size)
    if AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr {
        return value
    }
    return nil
}

for id in deviceIDs() {
    let name = stringProperty(id, kAudioObjectPropertyName)
    if name.contains("Music Project") || name.contains("多输出") {
        print("DEVICE \(id) \(name) \(stringProperty(id, kAudioDevicePropertyDeviceUID))")
        print(composition(id) ?? "no composition")
    }
}
