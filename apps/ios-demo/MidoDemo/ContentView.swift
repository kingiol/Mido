import MidoClient
import SwiftUI

struct ContentView: View {
  @ObservedObject var store: DemoAgentStore

  var body: some View {
    NavigationView {
      VStack(spacing: 0) {
        HeaderView(store: store)
        Divider()
        TranscriptView(store: store)
      }
      .background(Color(.systemGroupedBackground))
      .safeAreaInset(edge: .bottom) {
        InputBar(store: store)
      }
      .navigationBarHidden(true)
      .sheet(item: $store.activeSheet) { sheet in
        switch sheet {
        case .settings:
          SettingsView(store: store)
        }
      }
      .alert("Error", isPresented: store.errorBinding) {
        Button("OK", role: .cancel) {
          store.errorMessage = nil
        }
      } message: {
        Text(store.errorMessage ?? "")
      }
    }
    .navigationViewStyle(.stack)
  }
}

private struct HeaderView: View {
  @ObservedObject var store: DemoAgentStore

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text("Mido")
            .font(.title2.weight(.semibold))
          Text(store.statusTitle)
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Spacer()

        Picker("Mode", selection: $store.mode) {
          ForEach(DemoMode.allCases) { mode in
            Text(mode.title).tag(mode)
          }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 178)

        Button {
          store.activeSheet = .settings
        } label: {
          Image(systemName: "gearshape")
            .font(.headline)
            .frame(width: 34, height: 34)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Settings")
      }

      HStack(spacing: 8) {
        StatusPill(status: store.snapshot?.status)
        Text(store.mode == .mock ? "Mock" : store.baseURLString)
          .font(.caption)
          .lineLimit(1)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 16)
    .padding(.bottom, 12)
    .background(Color(.systemBackground))
  }
}

private struct StatusPill: View {
  var status: AgentClientStatus?

  var body: some View {
    Label(title, systemImage: icon)
      .font(.caption.weight(.medium))
      .foregroundStyle(color)
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(color.opacity(0.12), in: Capsule())
  }

  private var title: String {
    switch status {
    case .running:
      return "running"
    case .awaitingClientTool:
      return "awaiting"
    case .finished:
      return "finished"
    case .cancelled:
      return "cancelled"
    case .error:
      return "error"
    case .idle, .none:
      return "idle"
    }
  }

  private var icon: String {
    switch status {
    case .running:
      return "waveform"
    case .awaitingClientTool:
      return "hand.raised"
    case .finished:
      return "checkmark.circle"
    case .cancelled:
      return "xmark.circle"
    case .error:
      return "exclamationmark.triangle"
    case .idle, .none:
      return "circle"
    }
  }

  private var color: Color {
    switch status {
    case .running:
      return .blue
    case .awaitingClientTool:
      return .orange
    case .finished:
      return .green
    case .cancelled:
      return .gray
    case .error:
      return .red
    case .idle, .none:
      return .secondary
    }
  }
}

private struct TranscriptView: View {
  @ObservedObject var store: DemoAgentStore

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        if store.hasEmptyTranscript {
          PromptGrid(store: store)
        }

        ForEach(store.messageRows) { row in
          MessageBubble(row: row)
        }

        if let transcript = store.liveTranscriptText {
          MessageBubble(row: MessageRow(role: "assistant", text: transcript))
        }

        ForEach(store.snapshot?.pendingInteractiveTools ?? [], id: \.toolCallId) { toolCall in
          PendingToolCard(store: store, toolCall: toolCall)
        }
      }
      .padding(18)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private struct PromptGrid: View {
  @ObservedObject var store: DemoAgentStore

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(store.presets, id: \.self) { preset in
        Button {
          Task {
            await store.sendPreset(preset)
          }
        } label: {
          HStack {
            Image(systemName: preset.contains("delete") ? "trash" : "location.magnifyingglass")
            Text(preset)
            Spacer()
            Image(systemName: "arrow.up.right")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .padding(12)
          .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
      }
    }
  }
}

private struct MessageBubble: View {
  var row: MessageRow

  var body: some View {
    HStack {
      if row.role == "assistant" {
        bubble
        Spacer(minLength: 32)
      } else {
        Spacer(minLength: 32)
        bubble
      }
    }
  }

  private var bubble: some View {
    Text(row.text)
      .font(.body)
      .foregroundStyle(row.role == "assistant" ? Color.primary : Color.white)
      .padding(.horizontal, 13)
      .padding(.vertical, 10)
      .background(row.role == "assistant" ? Color(.secondarySystemGroupedBackground) : Color.accentColor, in: RoundedRectangle(cornerRadius: 8))
      .textSelection(.enabled)
  }
}

private struct PendingToolCard: View {
  @ObservedObject var store: DemoAgentStore
  var toolCall: ToolCallSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Label(toolCall.toolName, systemImage: "hammer")
          .font(.headline)
        Spacer()
        Text(toolCall.executionPolicy.rawValue)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }

      Text(jsonString(toolCall.args))
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(.secondary)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))

      HStack(spacing: 10) {
        Button {
          Task {
            await store.approve(toolCall)
          }
        } label: {
          Label("Approve", systemImage: "checkmark")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)

        Button(role: .destructive) {
          Task {
            await store.reject(toolCall)
          }
        } label: {
          Label("Reject", systemImage: "xmark")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
      }
    }
    .padding(14)
    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
  }
}

private struct InputBar: View {
  @ObservedObject var store: DemoAgentStore

  var body: some View {
    HStack(spacing: 10) {
      TextField("Message", text: $store.inputText)
        .textInputAutocapitalization(.sentences)
        .disableAutocorrection(false)
        .padding(.horizontal, 12)
        .frame(minHeight: 42)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))

      Button {
        Task {
          await store.sendCurrentMessage()
        }
      } label: {
        Image(systemName: store.isSending ? "hourglass" : "paperplane.fill")
          .frame(width: 42, height: 42)
      }
      .buttonStyle(.borderedProminent)
      .disabled(store.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isSending)
      .accessibilityLabel("Send")
    }
    .padding(12)
    .background(.regularMaterial)
  }
}

private struct SettingsView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var store: DemoAgentStore

  var body: some View {
    NavigationView {
      Form {
        Section {
          Picker("Mode", selection: $store.mode) {
            ForEach(DemoMode.allCases) { mode in
              Text(mode.title).tag(mode)
            }
          }

          TextField("Base URL", text: $store.baseURLString)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
            .disableAutocorrection(true)
        }

        Section {
          Button(role: .destructive) {
            Task {
              await store.clearConversation()
            }
          } label: {
            Label("Reset", systemImage: "arrow.counterclockwise")
          }
        }
      }
      .navigationTitle("Settings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            dismiss()
          }
        }
      }
    }
  }
}

private func jsonString(_ object: JSONObject) -> String {
  guard
    let data = try? JSONEncoder.mido.encode(JSONValue.object(object)),
    let string = String(data: data, encoding: .utf8)
  else {
    return "{}"
  }
  return string
}

#Preview {
  ContentView(store: DemoAgentStore())
}
