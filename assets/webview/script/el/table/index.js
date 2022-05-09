import { El } from '../index.js'

export function THead(fields) {
  return El('thead', '', [
    El('tr', '', fields.map(th =>
      th instanceof HTMLTableCellElement
        ? th
        : El('th', '', [th])
    ))
  ])
}

export function TBody(data) {
  return El('tbody', '', 
    data.map(record =>
      El('tr', '', record.map(td => 
        td instanceof HTMLTableCellElement
          ? td
          : El('td', '', [td])
      ))
    )
  )
}

export class Table {
  constructor(fields = [], data = [], className) {
    this.$el = El('table', className, [
      THead(fields),
      TBody(data)
    ])
  }
  tbody(data) {
    const current = this.$el.querySelector('tbody')
    if(data) {
      const newDom = TBody(data)
      current.replaceWith(newDom)
      return newDom
    } else {
      return current
    }
  }
  thead(fields) {
    const current = this.$el.querySelector('thead')
    if(fields) {
      const newDom = THead(fields)
      console.debug('thead replaced with', newDom)
      current.replaceWith(newDom)
      return newDom
    } else {
      return current
    }
  }
}