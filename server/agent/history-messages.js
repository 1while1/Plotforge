// Map only server-selected conversation rows to model messages. The summary
// row is produced by history-selection; clients cannot submit system history.
function toModelHistory(messages) {
  return (Array.isArray(messages) ? messages : []).flatMap(message => {
    if (message.role === 'system') {
      return message.source === 'system' && message.content?.startsWith('【上下文压缩存档】')
        ? [{ role: 'system', content: message.content }] : [];
    }
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    return [{ role: message.source === 'system' ? 'system' : message.role, content: message.content }];
  });
}

module.exports = { toModelHistory };
