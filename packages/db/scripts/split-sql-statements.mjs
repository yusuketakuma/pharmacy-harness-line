/** Split SQLite statements without cutting quoted text or trigger bodies. */
export function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let head = [];
  let previous = '';
  let current = '';
  const token = (value) => {
    if (head.length < 3) head.push(value);
    previous = current;
    current = value;
  };
  const emit = (end) => {
    if (head.length) statements.push(sql.slice(start, end).trim());
    start = end + 1;
    head = [];
    previous = current = '';
  };

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (/\s/.test(ch)) continue;
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated SQL block comment');
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let closed = false;
      for (i += 1; i < sql.length; i += 1) {
        if (sql[i] !== close) continue;
        if (close !== ']' && sql[i + 1] === close) i += 1;
        else {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error('unterminated SQL quote');
      token('quoted');
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const wordStart = i;
      while (i + 1 < sql.length && /[A-Za-z_0-9$]/.test(sql[i + 1])) i += 1;
      token(sql.slice(wordStart, i + 1).toUpperCase());
      continue;
    }
    if (ch === ';') {
      const trigger =
        head[0] === 'CREATE' &&
        (head[1] === 'TRIGGER' || ((head[1] === 'TEMP' || head[1] === 'TEMPORARY') && head[2] === 'TRIGGER'));
      // A trigger closes with "; END;". CASE ... END inside a body
      // statement cannot match, nor can END in a string or comment.
      if (!trigger || (previous === ';' && current === 'END')) emit(i);
      else token(';');
      continue;
    }
    token(ch);
  }
  emit(sql.length);
  return statements;
}
