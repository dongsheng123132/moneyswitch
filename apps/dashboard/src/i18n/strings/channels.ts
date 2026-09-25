import { defineMessages } from "../index";

/** Channels page copy (docs/ux-audit.md A-6, A-7). */
export const channelsStrings = defineMessages(
  {
    intro: "A channel is an OpenAI-compatible upstream priced with x402 — when an agent chats through MoneySwitch, the model name picks the channel and MoneySwitch pays it.",
    addChannel: "Add channel",
    addManually: "Add manually",
    addDemoChannel: "Add demo channel (one click)",
    addingDemo: "Adding…",
    demoAddSuccess: "Demo channel added.",
    demoAddFailedTitle: "Couldn't add the demo channel",

    emptyTitle: "No channels yet",
    emptyBody: "Add an OpenAI-compatible, x402-priced upstream to route chat completions through — start with the one-click demo channel or add your own.",

    demoSellerUnknownTitle: "The server doesn't know where the demo seller runs",
    demoSellerUnknownBody: "Check the port and fix the base URL below.",

    drawerTitle: "Add channel",
    prefillDemo: "Prefill: Demo LLM (x402)",
    fieldName: "Name",
    fieldBaseUrl: "Base URL",
    baseUrlHint: "OpenAI-compatible base URL, usually ends with /v1.",
    fieldModels: "Models (comma-separated)",
    fetchModels: "Fetch models from upstream",
    fetchingModels: "Fetching…",
    fetchModelsFound: "Found {n} models.",
    fetchModelsEmpty: "Upstream returned no models.",
    fieldRequired: "Required.",

    colName: "Name",
    colBaseUrl: "Base URL",
    colModels: "Models",
    colStatus: "Status",
    colActions: "",
    statusEnabled: "Enabled",
    statusDisabled: "Disabled",
    deleteConfirm: "Delete? Agents using its models will get model_not_found.",
    deleteConfirmYes: "Yes, delete",
    deleteAction: "Delete",
  },
  {
    intro: "渠道是按次收费（x402）的 OpenAI 兼容上游；Agent 通过 MoneySwitch 对话时，按模型名选渠道，由 MoneySwitch 付钱给它。",
    addChannel: "添加渠道",
    addManually: "手动添加",
    addDemoChannel: "一键添加 demo 渠道",
    addingDemo: "添加中…",
    demoAddSuccess: "已添加 demo 渠道。",
    demoAddFailedTitle: "添加 demo 渠道失败",

    emptyTitle: "还没有渠道",
    emptyBody: "添加一个按 x402 计费、兼容 OpenAI 接口的上游，才能路由对话请求——可以先一键添加 demo 渠道，或手动添加。",

    demoSellerUnknownTitle: "服务端不知道 demo 卖方跑在哪个地址",
    demoSellerUnknownBody: "请检查端口，在下面修正 Base URL。",

    drawerTitle: "添加渠道",
    prefillDemo: "预填：Demo LLM (x402)",
    fieldName: "名称",
    fieldBaseUrl: "Base URL",
    baseUrlHint: "OpenAI 兼容的 Base URL，通常以 /v1 结尾。",
    fieldModels: "模型（逗号分隔）",
    fetchModels: "从上游拉取模型",
    fetchingModels: "拉取中…",
    fetchModelsFound: "找到 {n} 个模型。",
    fetchModelsEmpty: "上游没有返回模型。",
    fieldRequired: "必填。",

    colName: "名称",
    colBaseUrl: "Base URL",
    colModels: "模型",
    colStatus: "状态",
    colActions: "",
    statusEnabled: "已启用",
    statusDisabled: "已禁用",
    deleteConfirm: "确认删除？用到这些模型的 Agent 会收到 model_not_found。",
    deleteConfirmYes: "确认删除",
    deleteAction: "删除",
  }
);
