/** Internal raw frames, intentionally separate from the public JPEG preview VideoFrame. */
export interface VideoSourceFormat {
  width: number;
  height: number;
  fps: number;
  pixelFormat: 'i420' | 'rgba';
}
export interface VideoSourceFrame extends VideoSourceFormat {
  callId: string;
  sourceId: string;
  kind: 'generated' | 'camera' | 'screen';
  sequence: number;
  /** Unix milliseconds, captured/generated at source. */
  timestamp: number;
  data: Uint8Array;
}
export interface VideoSourceReceipt {
  callId: string;
  sourceId: string;
  sequence: number;
  acceptedBytes: number;
  dispatchedBytes: number;
  state: 'dispatched' | 'dropped' | 'cancelled' | 'failed';
  /** e.g. pyvirtualcam-send: local submission only, never remote delivery/display. */
  evidence?: string;
  error?: string;
}
