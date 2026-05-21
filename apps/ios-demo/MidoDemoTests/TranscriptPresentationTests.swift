import XCTest
import MidoClient
@testable import MidoDemo

final class TranscriptPresentationTests: XCTestCase {
  func testLiveTranscriptIsHiddenAfterItIsCommittedToConversation() {
    let assistantMessage = AgentMessage.text(
      role: .assistant,
      text: "Weather for Shanghai: clear skies with a light breeze.",
      id: "msg_assistant"
    )

    XCTAssertNil(visibleLiveTranscriptText(
      transcript: "Weather for Shanghai: clear skies with a light breeze.",
      conversationMessages: [assistantMessage]
    ))
  }

  func testLiveTranscriptIsShownWhileItHasNotBeenCommitted() {
    XCTAssertEqual(
      visibleLiveTranscriptText(
        transcript: "Streaming response",
        conversationMessages: []
      ),
      "Streaming response"
    )
  }
}
