import type { ContextMessage } from '@moonshot-ai/kimi-code-sdk';
import { Key, matchesKey, ScrollView, Text, VStack, type Component, type Focusable } from '@moonshot-ai/pi-tui';

import { GutterContainer } from '../chrome/gutter-container';
import { AssistantMessageComponent } from './assistant-message';
import { UserMessageComponent } from './user-message';
import { ToolCallComponent } from './tool-call';
import { ThinkingComponent } from './thinking';
import { TranscriptView } from './transcript-view';
import { currentTheme } from '#/tui/theme';
import { contentPartsToText, createReplayRenderContext, toolCallFromReplayMessage, toolResultOutput } from '#/tui/utils/message-replay';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { printableChar } from '#/tui/utils/printable-key';

export class AgentTranscriptView extends VStack implements Focusable {
  focused = false;
  private readonly content = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  private readonly transcript = new TranscriptView(this.content);
  private readonly calls = new Map<string, ToolCallComponent>();
  private expanded = false;
  private signature = '';

  constructor(agentId: string, private readonly onClose: () => void, private readonly requestRender: () => void) {
    super();
    this.addChild(new Text(currentTheme.boldFg('primary', `Agent ${agentId}`) + currentTheme.fg('textMuted', ' · ↑↓/PgUp/PgDn scroll · Ctrl-O expand · Esc cancel'), CHROME_GUTTER, 0), { shrink: 0 });
    this.addChild(this.transcript, { basis: 0, grow: 1, minSize: 1 });
  }

  setMessages(messages: readonly ContextMessage[]): void {
    const signature = JSON.stringify(messages);
    if (signature === this.signature) return;
    this.signature = signature;
    this.content.clear();
    const context = createReplayRenderContext();
    const components: Component[] = [];
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') {
        const component = message.toolCallId === undefined ? undefined : this.calls.get(message.toolCallId);
        component?.setResult({ tool_call_id: message.toolCallId!, output: toolResultOutput(message.content), is_error: message.isError });
        continue;
      }
      const text = contentPartsToText(message.content.filter(part => part.type !== 'think'));
      if (message.role === 'user') components.push(new UserMessageComponent(text));
      else {
        const thinking = message.content.filter(part => part.type === 'think').map(part => part.think).join('');
        if (thinking) { const component = new ThinkingComponent(thinking); component.setExpanded(this.expanded); components.push(component); }
        if (text) { const component = new AssistantMessageComponent(); component.updateContent(text); components.push(component); }
        for (const raw of message.toolCalls ?? []) {
          const data = toolCallFromReplayMessage(raw, context, message.toolCallDisplays?.[raw.id]);
          if (data === undefined) continue;
          let component = this.calls.get(raw.id);
          if (component === undefined) { component = new ToolCallComponent(data, undefined); this.calls.set(raw.id, component); }
          component.setExpanded(this.expanded);
          components.push(component);
        }
      }
    }
    for (const component of components) this.content.addChild(component);
    this.requestRender();
  }

  handleInput(data: string): void {
    const scroll = this.transcript.children[1];
    if (!(scroll instanceof ScrollView)) return;
    if (matchesKey(data, Key.escape) || printableChar(data) === 'q') { this.onClose(); return; }
    if (matchesKey(data, Key.ctrl('o'))) {
      this.expanded = !this.expanded;
      for (const component of this.content.children) {
        if (component instanceof ToolCallComponent || component instanceof ThinkingComponent) component.setExpanded(this.expanded);
      }
    } else if (matchesKey(data, Key.up)) scroll.scrollBy(-1);
    else if (matchesKey(data, Key.down)) scroll.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.pageDown)) scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.home)) scroll.scrollTo(0);
    else if (matchesKey(data, Key.end)) scroll.scrollToEnd();
    this.requestRender();
  }
}
