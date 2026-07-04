import Testing
@testable import MidoClient

@Suite("SDK version")
struct VersionTests {
  @Test("exports SDK and protocol version constants")
  func exportsVersionConstants() {
    #expect(MidoSDKVersion.sdk == "0.1.0")
    #expect(MidoSDKVersion.proto == "mido.protocol.v1")
  }
}
