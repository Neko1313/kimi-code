import type { PluginPaneInfo, RuntimeCommand, RuntimeElement } from '@moonshot-ai/agent-core-v2/app/plugin/runtime';
import type { PluginCallRequest, PluginKeyRequest, PluginPaneRequest } from '@moonshot-ai/agent-core-v2/app/plugin/agentRuntime';

import type { SDKRpcClientBase } from '#/rpc';
import type { Unsubscribe } from '#/types';

export interface PluginRuntimeClient {
  renderSite(input: import('@moonshot-ai/agent-core-v2/app/plugin/runtime').RuntimeSiteRequest): Promise<RuntimeElement | undefined>;
  dispatchSiteKey(input: { component: string; requestId?: string; key: string; clientId?: string }): Promise<void>;
  getView(input?: { clientId?: string }): Promise<import('@moonshot-ai/agent-core-v2/app/plugin/runtime').RuntimeView>;
  openSite(input: { component: string; surface?: import('@moonshot-ai/agent-core-v2/app/plugin/runtime').RuntimeRenderSurface; props?: Record<string, unknown> }): Promise<string | undefined>;
  closePane(input: { id: string }): Promise<void>;
  listPanes(): Promise<readonly PluginPaneInfo[]>;
  renderPane(input: PluginPaneRequest): Promise<RuntimeElement | undefined>;
  dispatchKey(input: PluginKeyRequest): Promise<void>;
  listCommands(): Promise<readonly RuntimeCommand[]>;
  runCommand(input: { name: string; args?: string }): Promise<unknown>;
  call(input: PluginCallRequest): Promise<unknown>;
  subscribe(listener: () => void): Promise<Unsubscribe>;
}

export function createPluginRuntimeClient(rpc: SDKRpcClientBase, sessionId: string, ensureOpen: () => void): PluginRuntimeClient {
  return {
    renderSite: input => { ensureOpen(); return rpc.renderPluginSite({ sessionId, ...input }); },
    dispatchSiteKey: input => { ensureOpen(); return rpc.dispatchPluginSiteKey({ sessionId, ...input }); },
    getView: input => { ensureOpen(); return rpc.getPluginView({ sessionId, clientId: input?.clientId }); },
    openSite: (input) => { ensureOpen(); return rpc.openPluginSite({ sessionId, ...input }); },
    closePane: input => { ensureOpen(); return rpc.closePluginPane({sessionId,...input}); },
    listPanes: () => { ensureOpen(); return rpc.listPluginPanes({ sessionId }); },
    renderPane: (input) => { ensureOpen(); return rpc.renderPluginPane({ sessionId, ...input }); },
    dispatchKey: (input) => { ensureOpen(); return rpc.dispatchPluginKey({ sessionId, ...input }); },
    listCommands: () => { ensureOpen(); return rpc.listRuntimeCommands({ sessionId }); },
    runCommand: (input) => { ensureOpen(); return rpc.runRuntimeCommand({ sessionId, ...input }); },
    call: (input) => { ensureOpen(); return rpc.callPluginMethod({ sessionId, ...input }); },
    subscribe: (listener) => { ensureOpen(); return rpc.subscribePluginRuntime({ sessionId }, listener); },
  };
}

export type { PluginPaneInfo, RuntimeCommand, RuntimeElement, PluginCallRequest, PluginKeyRequest, PluginPaneRequest };

export type { RuntimePluginApi, RuntimeRegistrar, RuntimeAgentOptions, RuntimeAgentResult, RuntimeContext, RuntimeMethod, RuntimeHandler, RuntimeScriptOptions, RuntimeActivity, RuntimeCapability } from '@moonshot-ai/agent-core-v2/app/plugin/runtime';
