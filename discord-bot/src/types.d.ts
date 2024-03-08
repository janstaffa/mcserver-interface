// incoming:
//  1001 => log message
//  1002 => server status change
//  1003 => message
//  1004 => error message
export interface WSMessage<T> {
  code: number;
  payload: T;
}