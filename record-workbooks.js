const XLSX = require('xlsx');
const records = require('./record-store');
module.exports = { ...XLSX, readFile: records.readWorkbook,
  writeFile(book, file, options) {
    return records.managed(file) ? records.saveWorkbook(file, book) : XLSX.writeFile(book, file, options);
  } };
