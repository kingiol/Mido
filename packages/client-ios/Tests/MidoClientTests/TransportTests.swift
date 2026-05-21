import XCTest
@testable import MidoClient

final class TransportTests: XCTestCase {
  func testSSEDecoderParsesMultiLineDataEvents() throws {
    var decoder = SSEEventDecoder()
    let first = try decoder.append("""
    event: message
    data: {"type":"TEXT_DELTA","eventId":"event_1","sequence":1,
    data: "runId":"run_test","messageId":"msg_1","timestamp":"2026-04-28T00:00:00.000Z","textId":"text_1","delta":"Hi"}

    """ + "\n")

    guard first.count == 1, case let .textDelta(event) = first[0] else {
      return XCTFail("Expected TEXT_DELTA event")
    }
    XCTAssertEqual(event.delta, "Hi")

    let second = try decoder.append("""
    data: {"type":"RUN_FINISHED","eventId":"event_2","sequence":2,"runId":"run_test","messageId":"msg_1","timestamp":"2026-04-28T00:00:00.000Z","finishReason":"completed"}

    """ + "\n")
    XCTAssertEqual(second.count, 1)
    XCTAssertEqual(second[0].runId, "run_test")
  }
}
