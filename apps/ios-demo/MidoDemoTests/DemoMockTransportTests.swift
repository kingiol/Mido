import XCTest
import MidoClient
@testable import MidoDemo

final class DemoMockTransportTests: XCTestCase {
  func testWeatherPromptRequestsAutoLocationTool() async throws {
    let transport = DemoMockTransport()
    let stream = try await transport.startRun(RunStartRequest(
      runId: "run_demo",
      threadId: "thread_demo",
      messages: [
        AgentMessage.text(
          role: .user,
          text: "weather here",
          id: "msg_user",
          createdAt: "2026-05-21T00:00:00.000Z"
        )
      ]
    ))

    let events = try await collect(stream)

    guard case let .toolCallEnd(toolCall)? = events.first(where: { event in
      if case .toolCallEnd = event {
        return true
      }
      return false
    }) else {
      return XCTFail("Expected a tool call event")
    }

    XCTAssertEqual(toolCall.toolName, "deviceLocation")
    XCTAssertEqual(toolCall.executionPolicy, ToolExecutionPolicy.clientAuto)
    XCTAssertTrue(events.contains { event in
      if case let .runFinished(finished) = event {
        return finished.finishReason == .awaitingClientTool
      }
      return false
    })
  }

  func testRejectedInteractiveResumeProducesCancellationText() async throws {
    let transport = DemoMockTransport()
    let stream = try await transport.resume(RunResumeRequest(
      runId: "run_demo",
      toolResult: ToolResultEnvelope(
        runId: "run_demo",
        messageId: "msg_tool",
        toolCallId: "tool_call_delete",
        toolId: "client:deleteDraft",
        toolName: "deleteDraft",
        modelName: "client__deleteDraft",
        output: ["code": "client_tool_rejected"],
        isError: true
      )
    ))

    let events = try await collect(stream)

    guard case let .textEnd(textEnd)? = events.first(where: { event in
      if case .textEnd = event {
        return true
      }
      return false
    }) else {
      return XCTFail("Expected a text response")
    }

    XCTAssertTrue(textEnd.text.localizedCaseInsensitiveContains("cancelled"))
    XCTAssertTrue(events.contains { event in
      if case let .runFinished(finished) = event {
        return finished.finishReason == .completed
      }
      return false
    })
  }
}

private func collect(_ stream: AsyncThrowingStream<CoreEvent, Error>) async throws -> [CoreEvent] {
  var events: [CoreEvent] = []
  for try await event in stream {
    events.append(event)
  }
  return events
}
