// outgoing:
//  1001 => log message
//  1002 => server status change
//  1003 => message
//  1004 => error message
//
// incoming:
//  2001 => command

export interface WSMessage<T> {
  code: number;
  payload: T;
}

export interface CommandPayload {
  command: string,
  data?: string
}
