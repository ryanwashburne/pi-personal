export type GatewayResult = {
  status: number;
  body: string;
  headers?: Record<string, string>;
  work?: () => Promise<void>;
};
