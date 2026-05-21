import XCTest
@testable import MidoClient

final class ProtocolCodableTests: XCTestCase {
  func testCoreEventDecodesTextDeltaByType() throws {
    let data = """
    {
      "type": "TEXT_DELTA",
      "eventId": "event_1",
      "sequence": 3,
      "runId": "run_test",
      "messageId": "msg_assistant",
      "timestamp": "2026-04-28T00:00:00.000Z",
      "textId": "text_1",
      "delta": "Hello"
    }
    """.data(using: .utf8)!

    let event = try JSONDecoder.mido.decode(CoreEvent.self, from: data)

    guard case let .textDelta(textDelta) = event else {
      return XCTFail("Expected TEXT_DELTA event")
    }
    XCTAssertEqual(event.runId, "run_test")
    XCTAssertEqual(textDelta.delta, "Hello")
  }

  func testRunStartRequestEncodesClientToolDefinitions() throws {
    let request = RunStartRequest(
      runId: "run_test",
      threadId: "thread_test",
      messages: [
        AgentMessage.text(
          role: .user,
          text: "weather here",
          id: "msg_user",
          createdAt: "2026-04-28T00:00:00.000Z"
        )
      ],
      clientTools: [
        ToolDefinition(
          name: "getLocation",
          description: "Read the current approximate location.",
          inputSchema: ["type": "object", "additionalProperties": true],
          resultSchema: [
            "type": "object",
            "required": ["city"],
            "properties": ["city": ["type": "string"]]
          ],
          executionPolicy: .clientAuto
        ).normalized()
      ]
    )

    let data = try JSONEncoder.mido.encode(request)
    let decoded = try JSONDecoder.mido.decode(RunStartRequest.self, from: data)

    XCTAssertEqual(decoded.clientTools?.first?.toolId, "client:getLocation")
    XCTAssertEqual(decoded.clientTools?.first?.modelName, "client__getLocation")
    XCTAssertEqual(decoded.messages.first?.content, [.text(TextPart(text: "weather here"))])
  }
}
