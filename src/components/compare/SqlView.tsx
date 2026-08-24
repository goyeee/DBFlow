import type { ReactNode } from 'react'

/** MySQL 关键字/类型（Navicat DDL 比较里这些显示为蓝色） */
const KEYWORDS = new Set([
  'create', 'table', 'alter', 'add', 'modify', 'drop', 'column', 'first', 'after',
  'if', 'not', 'exists', 'null', 'default', 'comment', 'primary', 'key', 'index',
  'unique', 'using', 'btree', 'engine', 'charset', 'collate', 'character', 'set',
  'auto_increment', 'unsigned', 'zerofill', 'on', 'update', 'current_timestamp',
  // 类型
  'int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint',
  'varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext',
  'decimal', 'numeric', 'float', 'double', 'real',
  'datetime', 'timestamp', 'date', 'time', 'year',
  'json', 'blob', 'tinyblob', 'mediumblob', 'longblob',
  'binary', 'varbinary', 'enum', 'bit', 'innodb', 'myisam',
])

const TOKEN_RE = /(`[^`]*`|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|[A-Za-z_][A-Za-z0-9_]*)/g

/** 单行 SQL → 高亮节点：关键字蓝、字符串红、数字绿、反引号标识符原色 */
export function highlightSqlLine(line: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(<span key={k++} className="sql-ident">{tok}</span>)
    } else if (tok.startsWith("'")) {
      out.push(<span key={k++} className="sql-str">{tok}</span>)
    } else if (/^\d/.test(tok)) {
      out.push(<span key={k++} className="sql-num">{tok}</span>)
    } else if (KEYWORDS.has(tok.toLowerCase())) {
      out.push(<span key={k++} className="sql-kw">{tok}</span>)
    } else {
      out.push(tok)
    }
    last = m.index + tok.length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

/** 只读 SQL 面板（DDL 比较/部署脚本用），不带行号 */
export function SqlView({ sql, emptyText }: { sql: string | null; emptyText: string }) {
  if (!sql) {
    return <div className="sql-view sql-view-empty">{emptyText}</div>
  }
  return (
    <div className="sql-view">
      <pre className="sql-code">
        {sql.split('\n').map((ln, i) => (
          <div key={i}>{highlightSqlLine(ln)}</div>
        ))}
      </pre>
    </div>
  )
}
