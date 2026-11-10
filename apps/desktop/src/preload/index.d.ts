export {};
declare global {
  interface Window {
    cadre?: {
      serverUrl: string;
      platform: string;
      notify(n: { title: string; body: string; botId?: string; conversationId?: string }): void;
      setBadge(count: number): void;
      isFocused(): Promise<boolean>;
      getZoom?(): Promise<number>;
      setZoom?(factor: number): void;
      copyText?(text: string): void;
    };
  }
  interface WindowEventMap {
    "cadre:open": CustomEvent<{ botId?: string; conversationId?: string }>;
    "cadre:zoom": CustomEvent<number>;
  }
}
