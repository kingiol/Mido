import SwiftUI

@main
struct MidoDemoApp: App {
  @StateObject private var store = DemoAgentStore()

  var body: some Scene {
    WindowGroup {
      ContentView(store: store)
        .task {
          await store.configureIfNeeded()
        }
    }
  }
}
