/// Demo application prompts — centralized prompt management for the Mido iOS demo.
///
/// SDK-layer (infrastructure) prompts live in packages/server-sdk/src/prompts/.
/// This file contains only demo-specific, user-facing prompt templates.

import Foundation

/// Default system prompt for the iOS demo agent client.
enum DemoPrompts {
    static let systemPrompt = "You are running inside the Mido iOS demo."
}
