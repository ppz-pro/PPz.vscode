const vscode = require('vscode')
const Knex = require('knex')
const noty = require('../../../lib/vscode-utils/noty')
const untitledFile = require('../../../lib/vscode-utils/untitled-file')

class KnexConnection {
  constructor(clientName, knexClient, name, connection, useNullAsDefault) {
    this.clientName = clientName
    this.clientType = knexClient
    this.name = name
    this.options = connection
    this.client = Knex({
      client: knexClient,
      connection,
      useNullAsDefault,
      acquireConnectionTimeout: 10000,
      pool: { min: 0, max: 1 }
    })
  }
  
  async fieldList(schemaName, tableName) {
    const fields = await this._fieldList(schemaName, tableName)
    this.fields = fields // 保存最新的 fields
    return fields
  }
  formatInput(records) {
    const dateNames = this.fields
      .filter(f => f.ppzType == 'datetime-ts')
      .map(f => f.name)
    for(let record of records)
      for(let name of dateNames)
        if((record[name] !== '') && (typeof record[name] == 'string'))
          record[name] = new Date(record[name])
  }

  getTarget(schema, table) {
    return '`' + schema + '`.`' + table + '`'
  }

  getCount(count) {
    return count[0]['count(*)']
  }
  async select(schema, table, { page, fields = ['*'], }) {
    console.debug('sql select', { schema, table })
    const records = await this._queryBuilder(schema, table)
      .select(...fields)
      .offset((page.index - 1) * page.size).limit(page.size)
    const count = await this._queryBuilder(schema, table).count()
    return {
      records,
      count: this.getCount(count)
    }
  }

  async insert(db, tb, record) {
    this.formatInput([record])
    return await this._queryBuilder(db, tb).insert(record)
  }

  _queryBuilder(schema, table) {
    if(schema)
      table = schema + '.' + table
    return this.client.from(table)
  }

  async updateMany(db, tb, changedList) {
    this.formatInput(changedList.map(item => item.changed))
    const table = db? db + '.' + tb : tb
    return await this.client.transaction(trx =>
      Promise.all(changedList.map(
        item => trx(table).where(item.pk).update(item.changed)
      ))
    )
  }

  async drop(db, tb, where) {
    if(Object.keys(where).length == 0)
      throw Error('deleting all data?')
    return this._queryBuilder(db, tb).where(where).del()
  }

  async close() {
    console.debug('connection closing...', this.name)
    await this.client.destroy()
    console.debug('connection closed')
  }

  terminal(...cmds) {
    const terminal = vscode.window.createTerminal()
    for(const cmd of cmds)
      terminal.sendText(cmd)
    terminal.show()
  }

  // Data Query Language
  async getDQL(schema, table) {
    const result = await this._queryBuilder(schema, table)
    return this._queryBuilder(schema, table).insert(result).toString()
  }
  async exportDQL(schema, table) {
    untitledFile.sql(await this.getDQL(schema, table))
  }
  async exportDDL(schema, table) {
    untitledFile.sql(await this.getDDL(schema, table))
  }
  // DDL & DQL
  async export(schema, table) {
    untitledFile.sql(
      await this.getDDL(schema, table),
      ';\n',
      await this.getDQL(schema, table)
    )
  }
}

const notyConnErr = err => {
  noty.error('连接失败，请检查连接信息或服务器 ' + err)
}

exports.MysqlKnexConnection =
class MysqlKnexConnection extends KnexConnection {
  constructor({ name, host, port, user, password, database }) {
    super('mysql', 'mysql2', name, {
      host, port, user, password, database
    })
  }
  async dbList() {
    try {
      const result = await this.client.raw('show databases;')
      return result[0].map(item => item.Database)
    } catch(err) {
      notyConnErr(err)
      return []
    }
  }
  async tbList(schema) {
    await this.client.raw('use `' + schema + '`')
    const result = await this.client.raw('show tables;')
    return result[0].map(item => item['Tables_in_' + schema])
  }
  
  async _fieldList(schema, table) {
    const result = await this.client.raw(`desc \`${schema}\`.\`${table}\``)
    return result[0].map(field => ({
      name: field.Field,
      type: field.Type,
      ppzType: this.ppzType(field.Type), // 便于格式化显示/解析
      notNull: field.Null == 'NO',
      default: field.Default,
      pk: field.Key == 'PRI'
    }))
  }
  ppzType(rawType) {
    if(
      (['date', 'datetime', 'timestamp'].indexOf(rawType) > -1)
      || /datetime\(\d*\)/.test(rawType)
      || /timestamp\(\d*\)/.test(rawType)
    )
      return 'datetime'
  }

  terminal() {
    super.terminal(`mysql -h${this.options.host}${
      this.options.port ? ':' + this.options.port : ''
    } -u${this.options.user} -p${this.options.password}`)
  }

  // Data Definition Language
  async getDDL(schema, table) {
    const res = await this.client.raw(`show create table ${this.getTarget(schema, table)}`)
    return res[0][0]['Create Table']
  }
}

exports.PostgreSQLKnexConnection =
class PostgreSQLKnexConnection extends KnexConnection {
  constructor({ name, host, port, user, password, database }) {
    super('postgresql', 'pg', name, {
      host, port, user, password, database
    })
  }
  async dbList() {
    try {
      const result = await this.client.raw('SELECT datname FROM pg_database WHERE datistemplate=false;')
      return result.rows.map(db => db.datname)
    } catch(err) {
      notyConnErr(err)
      return []
    }
  }
  async schemaList() {
    const result = await this.client.raw('select schema_name from information_schema.schemata;')
    return result.rows.map(row => row.schema_name)
  }
  async tbList(schemaName) {
    const result = await this.client.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema='${schemaName}';`)
    return result.rows.map(db => db.table_name)
  }
  async _fieldList(schemaName, tableName) {
    const result = await this.client.raw(`SELECT * FROM information_schema.COLUMNS WHERE table_schema='${schemaName}' and table_name='${tableName}';`)
    const pks = await this.client.raw(`SELECT a.attname
      FROM   pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE  i.indrelid = '${schemaName}.${tableName}'::regclass AND i.indisprimary;`)
    const pkNames = pks.rows.map(row => row.attname)
    return result.rows.map(field => ({
      name: field.column_name,
      type: field.udt_name,
      ppzType: this.ppzType(field.udt_name),
      notNull: !Boolean(field.is_nullable),
      default: field.column_default,
      pk: pkNames.indexOf(field.column_name) != -1
    }))
  }
  ppzType(rawType) {
    if(
      (['date', 'timestamp'].indexOf(rawType) > -1)
      || /timestamp\(\d*\)/.test(rawType)
    )
      return 'datetime'
    else if(
      'timestamptz' == rawType
      || /timestamptz\(\d*\)/.test(rawType)
    )
      return 'datetime-ts'
  }

  getCount(count) {
    return parseInt(count[0]['count'])
  }

  terminal() {
    let cmd = `psql -h ${this.options.host} -U ${this.options.user}`
    if(this.options.port)
      cmd += ' -p ' + this.options.port
    if(this.options.database)
      cmd += ' -d ' + this.options.database
    
    super.terminal(cmd)
  }

  async getDDL(schema, table) {
    const msg = '暂不支持 pgsql 系数据库导出表结构的操作'
    noty.error(msg)
    throw Error(msg)
  }
}

exports.Sqlite3KnexConnection =
class Sqlite3KnexConnection extends KnexConnection {
  constructor({ name, filename }) {
    super('sqlite3', 'sqlite3', name, { filename }, true)
  }
  
  async tbList() {
    try {
      return (await this.client.raw('Pragma table_list'))
        .filter(tb => tb.type == 'table' && tb.schema == 'main' && tb.name.indexOf('sqlite_') != 0)
        .map(tb => tb.name)
    } catch(err) {
      notyConnErr(err)
      return []
    }
  }

  async _fieldList(schema, table) {
    return (await this.client.raw(`Pragma table_info(\`${table}\`)`))
      .map(field => ({
        name: field.name,
        type: field.type,
        notNull: Boolean(field.notnull),
        default: field.dflt_value,
        pk: Boolean(field.pk)
      }))
  }

  terminal() {
    super.terminal('sqlite3 ' + this.options.filename)
  }

  async getDDL(schema, table) {
    const result = await this.client.raw(`select sql from sqlite_master where type="table" and name="${table}";`)
    return result[0].sql
  }
}