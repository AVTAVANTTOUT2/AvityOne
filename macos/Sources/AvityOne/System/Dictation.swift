import AVFoundation
import Speech
import SwiftUI
import AvityKit

/// Dictation into the composer. Same priority as the web UI: the engine's configured transcription command when there
/// is one (recording sent to /api/transcribe), otherwise Apple's on-device recognition, which never sends the audio.
@MainActor @Observable final class Dictation {
  enum Phase: Equatable { case idle, starting, listening, transcribing }

  var phase: Phase = .idle
  var error: String?
  var usesServer = false

  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var recorder: AVAudioRecorder?
  private var recording: URL?
  private var client: APIClient?
  private var language = "fr-FR"
  private var onText: ((String) -> Void)?
  /// Results of an older dictation are ignored once a new one started or it was cancelled.
  private var generation = 0

  var active: Bool { phase != .idle }

  func toggle(language: String, server: APIClient?, onText: @escaping (String) -> Void) async {
    if active { await stop() } else { await start(language: language, server: server, onText: onText) }
  }

  func start(language: String, server: APIClient?, onText: @escaping (String) -> Void) async {
    guard phase == .idle else { return }
    generation += 1
    let current = generation
    error = nil
    phase = .starting
    self.language = language
    self.onText = onText
    guard await AVCaptureDevice.requestAccess(for: .audio) else {
      fail("Micro refusé : autorise AvityOne dans Réglages Système → Confidentialité → Micro.")
      return
    }
    guard current == generation else { return }
    if let server, await serverTranscription(server) {
      startRecording(server)
    } else {
      await startRecognition()
    }
  }

  private func serverTranscription(_ client: APIClient) async -> Bool {
    guard let config = try? await client.config() else { return false }
    return !(config["transcription"]?["command"]?.string ?? "").isEmpty
  }

  private func startRecording(_ client: APIClient) {
    usesServer = true
    self.client = client
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("avity-dictee-\(UUID().uuidString).m4a")
    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000]
    do {
      let recorder = try AVAudioRecorder(url: url, settings: settings)
      guard recorder.record() else { throw APIError(status: 0, message: "enregistrement impossible") }
      self.recorder = recorder
      recording = url
      phase = .listening
    } catch { fail("Enregistrement impossible : \(error.localizedDescription)") }
  }

  private func startRecognition() async {
    usesServer = false
    let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { done in
      SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
    }
    guard status == .authorized else {
      fail("Reconnaissance vocale refusée : autorise AvityOne dans Réglages Système → Confidentialité → Reconnaissance vocale.")
      return
    }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
      fail("Reconnaissance indisponible pour \(language).")
      return
    }
    guard recognizer.supportsOnDeviceRecognition else {
      fail("La reconnaissance sur l’appareil n’est pas installée pour \(language) : active cette langue dans Réglages Système → Clavier → Dictée, ou configure un moteur de transcription.")
      return
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
    engine.prepare()
    do { try engine.start() } catch {
      input.removeTap(onBus: 0)
      fail("Micro indisponible : \(error.localizedDescription)")
      return
    }
    self.engine = engine
    self.request = request
    let current = generation
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      let text = result?.bestTranscription.formattedString
      let final = result?.isFinal ?? false
      let failed = error != nil
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, current == self.generation else { return }
          if let text { self.onText?(text) }
          if final || failed { self.finishRecognition() }
        }
      }
    }
    phase = .listening
  }

  func stop() async {
    switch phase {
    case .listening where usesServer: await finishRecording()
    case .listening, .starting:
      engine?.stop()
      engine?.inputNode.removeTap(onBus: 0)
      request?.endAudio()
      if task == nil { finishRecognition() }
    default: break
    }
  }

  func cancel() {
    generation += 1
    task?.cancel()
    recorder?.stop()
    if let recording { try? FileManager.default.removeItem(at: recording) }
    finishRecognition()
  }

  private func finishRecognition() {
    engine?.stop()
    engine?.inputNode.removeTap(onBus: 0)
    engine = nil
    request = nil
    task = nil
    recorder = nil
    recording = nil
    phase = .idle
  }

  private func finishRecording() async {
    guard let recorder, let url = recording, let client else { finishRecognition(); return }
    recorder.stop()
    phase = .transcribing
    let current = generation
    defer { try? FileManager.default.removeItem(at: url) }
    do {
      let data = try Data(contentsOf: url)
      guard data.count <= 5 * 1024 * 1024 else { throw APIError(status: 413, message: "Enregistrement trop long (5 Mio au plus).") }
      let text = try await client.transcribe(audio: data, mime: "audio/mp4", language: language)
      if current == generation { onText?(text) }
    } catch {
      if current == generation { self.error = "Transcription échouée : \(error.localizedDescription)" }
    }
    if current == generation { finishRecognition() }
  }

  private func fail(_ message: String) {
    error = message
    finishRecognition()
  }
}
