// A tab switch used to leave the previously selected thread rendered even
// when it wasn't in the new tab's list (switch to Mine while viewing someone
// else's thread). This is the rule InboxClient.reloadList applies after
// loading a queue: a selectedId absent from the new list must be cleared.
export function nextSelection(loaded: Array<{ id: string }>, selectedId: string | null): string | null {
  return selectedId !== null && loaded.some((c) => c.id === selectedId) ? selectedId : null
}
