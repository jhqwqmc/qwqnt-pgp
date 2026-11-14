/** Direct conversations and QQ temporary direct conversations. */
export function isDirectChat(chatType: number): boolean {
  return [1, 99, 100, 101, 102, 103, 111, 117, 119].includes(chatType);
}
