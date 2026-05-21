import Foundation

public struct URLSessionSSETransport: AgentTransport {
  public var runURL: URL
  public var resumeURL: URL
  public var cancelURL: URL?
  public var headers: [String: String]
  private let session: URLSession

  public init(runURL: URL, resumeURL: URL, cancelURL: URL? = nil, headers: [String: String] = [:], session: URLSession = .shared) {
    self.runURL = runURL
    self.resumeURL = resumeURL
    self.cancelURL = cancelURL
    self.headers = headers
    self.session = session
  }

  public func startRun(_ request: RunStartRequest) async throws -> AsyncThrowingStream<CoreEvent, Error> {
    try await streamEvents(to: runURL, body: request)
  }

  public func resume(_ request: RunResumeRequest) async throws -> AsyncThrowingStream<CoreEvent, Error> {
    try await streamEvents(to: resumeURL, body: request)
  }

  public func cancelRun(_ request: RunCancelRequest) async throws -> CoreEvent? {
    guard let cancelURL else {
      return nil
    }

    var urlRequest = makeRequest(url: cancelURL)
    urlRequest.httpBody = try JSONEncoder.mido.encode(request)
    let (data, response) = try await session.data(for: urlRequest)
    try validateHTTPResponse(response)
    return try JSONDecoder.mido.decode(CancelResponse.self, from: data).event
  }

  private func streamEvents<T: Encodable>(to url: URL, body: T) async throws -> AsyncThrowingStream<CoreEvent, Error> {
    var request = makeRequest(url: url)
    request.httpBody = try JSONEncoder.mido.encode(body)
    let (bytes, response) = try await session.bytes(for: request)
    try validateHTTPResponse(response)

    return AsyncThrowingStream { continuation in
      let task = Task {
        var decoder = SSEEventDecoder()
        do {
          for try await line in bytes.lines {
            for event in try decoder.append("\(line)\n") {
              continuation.yield(event)
            }
          }

          for event in try decoder.finish() {
            continuation.yield(event)
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }

      continuation.onTermination = { _ in
        task.cancel()
      }
    }
  }

  private func makeRequest(url: URL) -> URLRequest {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
    for (name, value) in headers {
      request.setValue(value, forHTTPHeaderField: name)
    }
    return request
  }
}

struct SSEEventDecoder {
  private var buffer = ""

  mutating func append(_ chunk: String) throws -> [CoreEvent] {
    buffer += chunk.replacingOccurrences(of: "\r\n", with: "\n")
    buffer = buffer.replacingOccurrences(of: #"\n[ \t]+\n"#, with: "\n\n", options: .regularExpression)
    var events: [CoreEvent] = []

    while let range = buffer.range(of: "\n\n") {
      let eventChunk = String(buffer[..<range.lowerBound])
      buffer = String(buffer[range.upperBound...])
      if let data = parseData(from: eventChunk) {
        events.append(try JSONDecoder.mido.decode(CoreEvent.self, from: Data(data.utf8)))
      }
    }

    return events
  }

  mutating func finish() throws -> [CoreEvent] {
    let remaining = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
    buffer = ""
    guard !remaining.isEmpty, let data = parseData(from: remaining) else {
      return []
    }
    return [try JSONDecoder.mido.decode(CoreEvent.self, from: Data(data.utf8))]
  }

  private func parseData(from chunk: String) -> String? {
    let lines = chunk.split(separator: "\n", omittingEmptySubsequences: false)
    let dataLines = lines.compactMap { line -> String? in
      let trimmedLine = line.trimmingCharacters(in: .whitespaces)
      guard trimmedLine.hasPrefix("data:") else {
        return nil
      }
      return trimmedLine.dropFirst(5).trimmingCharacters(in: .whitespaces)
    }

    return dataLines.isEmpty ? nil : dataLines.joined(separator: "\n")
  }
}

private struct CancelResponse: Decodable {
  var event: CoreEvent?
}

private func validateHTTPResponse(_ response: URLResponse) throws {
  guard let httpResponse = response as? HTTPURLResponse else {
    throw MidoClientError.transportFailed("Transport response was not an HTTP response")
  }

  guard (200..<300).contains(httpResponse.statusCode) else {
    throw MidoClientError.transportFailed("Transport request failed with status \(httpResponse.statusCode)")
  }
}
