import * as csvParser from 'csv-parser';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as mongoose from 'mongoose';
import * as path from 'path';
import * as readline from 'readline';
import { Writable } from 'stream';
import { checkFieldNames } from '../data/modules/fields/utils';
import {
  createAWS,
  deleteFile,
  getConfig,
  uploadsFolderPath
} from '../data/utils';
import { Companies, Customers } from '../db/models';
import { CUSTOMER_SELECT_OPTIONS } from '../db/models/definitions/constants';
import {
  default as ImportHistories,
  default as ImportHistory
} from '../db/models/ImportHistory';
import { debugWorkers } from '../debuggers';
import CustomWorker from './workerUtil';

const { MONGO_URL = '' } = process.env;

export const connect = () =>
  mongoose.connect(MONGO_URL, { useNewUrlParser: true, useCreateIndex: true });

dotenv.config();

const WORKER_BULK_LIMIT = 500;

const myWorker = new CustomWorker();

export const IMPORT_CONTENT_TYPE = {
  CUSTOMER: 'customer',
  COMPANY: 'company',
  LEAD: 'lead',
  PRODUCT: 'product',
  DEAL: 'deal',
  TASK: 'task',
  TICKET: 'ticket'
};

const getCsvTotalRowCount = ({
  filePath,
  uploadType,
  s3,
  params
}: {
  filePath?: string;
  uploadType: string;
  params?: { Bucket: string; Key: string };
  s3?: any;
}): Promise<number> => {
  return new Promise(resolve => {
    if (uploadType === 'local' && filePath) {
      const readSteam = fs.createReadStream(filePath);

      let total = 0;

      const rl = readline.createInterface({
        input: readSteam,
        terminal: false
      });

      rl.on('line', () => total++);
      rl.on('close', () => resolve(total));
    } else {
      s3.selectObjectContent(
        {
          ...params,
          ExpressionType: 'SQL',
          Expression: 'SELECT COUNT(*) FROM S3Object',
          InputSerialization: {
            CSV: {
              FileHeaderInfo: 'USE',
              RecordDelimiter: '\n',
              FieldDelimiter: ','
            }
          },
          OutputSerialization: {
            CSV: {}
          }
        },
        (_, data) => {
          // data.Payload is a Readable Stream
          const eventStream = data.Payload;

          let total = 0;

          // Read events as they are available
          eventStream.on('data', event => {
            if (event.Records) {
              total = event.Records.Payload.toString();
            }
          });
          eventStream.on('end', () => {
            return resolve(total);
          });
        }
      );
    }
  });
};

const importBulkStream = ({
  fileName,
  bulkLimit,
  uploadType,
  handleBulkOperation
}: {
  fileName: string;
  bulkLimit: number;
  uploadType: 'AWS' | 'local';
  handleBulkOperation: (rows: any, total: number) => Promise<void>;
}) => {
  return new Promise(async (resolve, reject) => {
    let rows: any = [];
    let readSteam;
    let total;

    if (uploadType === 'AWS') {
      const AWS_BUCKET = await getConfig('AWS_BUCKET');

      const s3 = await createAWS();

      const errorCallback = error => {
        throw new Error(error.code);
      };

      const params = { Bucket: AWS_BUCKET, Key: fileName };

      total = await getCsvTotalRowCount({ s3, params, uploadType: 's3' });

      readSteam = s3.getObject(params).createReadStream();
      readSteam.on('error', errorCallback);
    } else {
      const filePath: string = `${uploadsFolderPath}/${fileName}`;

      readSteam = fs.createReadStream(filePath);
      total = await getCsvTotalRowCount({ filePath, uploadType });

      // exclude column
      total--;
    }

    const write = (row, _, callback) => {
      rows.push(row);

      if (rows.length === bulkLimit) {
        return handleBulkOperation(rows, total)
          .then(() => {
            rows = [];
            callback();
          })
          .catch(e => reject(e));
      }

      return callback();
    };

    readSteam
      .pipe(csvParser())
      .pipe(new Writable({ write, objectMode: true }))
      .on('finish', () => {
        handleBulkOperation(rows, total).then(() => {
          resolve('success');
        });
      })
      .on('error', e => reject(e));
  });
};

const getWorkerFile = fileName => {
  if (process.env.NODE_ENV !== 'production') {
    return `./src/workers/${fileName}.worker.import.js`;
  }

  if (fs.existsSync('./build/api')) {
    return `./build/api/workers/${fileName}.worker.js`;
  }

  return `./dist/workers/${fileName}.worker.js`;
};

export const clearEmptyValues = (obj: any) => {
  Object.keys(obj).forEach(key => {
    if (obj[key] === '' || obj[key] === 'unknown') {
      delete obj[key];
    }

    if (Array.isArray(obj[key]) && obj[key].length === 0) {
      delete obj[key];
    }
  });

  return obj;
};

export const updateDuplicatedValue = async (
  model: any,
  field: string,
  doc: any
) => {
  return model.updateOne(
    { [field]: doc[field] },
    { $set: { ...doc, modifiedAt: new Date() } }
  );
};

// csv file import, cancel, removal
export const receiveImportRemove = async (content: any) => {
  try {
    const { contentType, importHistoryId } = content;

    const handleOnEndWorker = async () => {
      const updatedImportHistory = await ImportHistory.findOne({
        _id: importHistoryId
      });

      if (updatedImportHistory && updatedImportHistory.status === 'Removed') {
        await ImportHistory.deleteOne({ _id: importHistoryId });
      }
    };

    myWorker.setHandleEnd(handleOnEndWorker);

    const importHistory = await ImportHistories.getImportHistory(
      importHistoryId
    );

    const ids = importHistory.ids || [];

    const workerPath = path.resolve(getWorkerFile('importHistoryRemove'));

    const calc = Math.ceil(ids.length / WORKER_BULK_LIMIT);
    const results: any[] = [];

    for (let index = 0; index < calc; index++) {
      const start = index * WORKER_BULK_LIMIT;
      const end = start + WORKER_BULK_LIMIT;
      const row = ids.slice(start, end);

      results.push(row);
    }

    for (const result of results) {
      await myWorker.createWorker(workerPath, {
        contentType,
        importHistoryId,
        result
      });
    }

    return { status: 'ok' };
  } catch (e) {
    debugWorkers('Failed to remove import: ', e.message);
    throw e;
  }
};

export const receiveImportCancel = () => {
  myWorker.removeWorkers();

  return { status: 'ok' };
};

export const beforeImport = async (type: string) => {
  const { LEAD, CUSTOMER, COMPANY } = IMPORT_CONTENT_TYPE;

  const existingEmails: string[] = [];
  const existingPhones: string[] = [];
  const existingCodes: string[] = [];
  const existingNames: string[] = [];

  const commonQuery = { status: { $ne: 'deleted' } };

  if (type === CUSTOMER || type === LEAD) {
    const customerValues = await Customers.find(commonQuery, {
      _id: 0,
      primaryEmail: 1,
      primaryPhone: 1,
      code: 1
    });

    for (const value of customerValues || []) {
      existingEmails.push((value || {}).primaryEmail || '');
      existingPhones.push((value || {}).primaryPhone || '');
      existingCodes.push((value || {}).code || '');
    }
  }

  if (type === COMPANY) {
    const companyValues = await Companies.find(commonQuery, {
      _id: 0,
      primaryName: 1,
      code: 1
    });

    for (const value of companyValues || []) {
      existingNames.push((value || {}).primaryName || '');
      existingCodes.push((value || {}).code || '');
    }
  }

  return {
    existingEmails,
    existingPhones,
    existingCodes,
    existingNames
  };
};

export const receiveImportCreate = async (content: any) => {
  const { fileName, type, scopeBrandIds, user, uploadType, fileType } = content;

  let fieldNames;
  let properties;
  let validationValues;
  let importHistory;

  if (fileType !== 'csv') {
    throw new Error('Invalid file type');
  }

  const updateImportHistory = async doc => {
    return ImportHistory.updateOne({ _id: importHistory.id }, doc);
  };

  const updateValidationValues = async () => {
    validationValues = await beforeImport(type);
  };

  const handleOnEndBulkOperation = async () => {
    const updatedImportHistory = await ImportHistory.findOne({
      _id: importHistory.id
    });

    if (!updatedImportHistory) {
      throw new Error('Import history not found');
    }

    if (
      updatedImportHistory.failed + updatedImportHistory.success ===
      updatedImportHistory.total
    ) {
      await updateImportHistory({
        $set: { status: 'Done', percentage: 100 }
      });
    }

    await deleteFile(fileName);
  };

  importHistory = await ImportHistory.create({
    contentType: type,
    userId: user._id,
    date: Date.now()
  });

  myWorker.setHandleEnd(handleOnEndBulkOperation);

  // collect initial validation values
  await updateValidationValues();

  const isRowValid = (row: any) => {
    const errors: Error[] = [];

    const { LEAD, CUSTOMER, COMPANY } = IMPORT_CONTENT_TYPE;

    const {
      existingCodes,
      existingEmails,
      existingPhones,
      existingNames
    } = validationValues;

    if (type === CUSTOMER || type === LEAD) {
      const { primaryEmail, primaryPhone, code } = row;

      if (existingCodes.includes(code)) {
        errors.push(new Error(`Duplicated code: ${code}`));
      }

      if (existingEmails.includes(primaryEmail)) {
        errors.push(new Error(`Duplicated email: ${primaryEmail}`));
      }

      if (existingPhones.includes(primaryPhone)) {
        errors.push(new Error(`Duplicated phone: ${primaryPhone}`));
      }

      return errors;
    }

    if (type === COMPANY) {
      const { primaryName, code } = row;

      if (existingNames.includes(primaryName)) {
        errors.push(new Error(`Duplicated name: ${primaryName}`));
      }

      if (existingCodes.includes(code)) {
        errors.push(new Error(`Duplicated code: ${code}`));
      }

      return errors;
    }

    return errors;
  };

  const handleBulkOperation = async (rows: any, totalRows: number) => {
    try {
      let errorMsgs: Error[] = [];

      if (!importHistory.total) {
        await updateImportHistory({
          $set: { total: totalRows }
        });
      }

      if (rows.length === 0) {
        debugWorkers('Please import at least one row of data');
      }

      if (!fieldNames) {
        const [fields] = rows;

        fieldNames = Object.keys(fields);
        properties = await checkFieldNames(type, fieldNames);
      }

      const result: unknown[] = [];

      for (const row of rows) {
        const errors = isRowValid(row);

        errors.length > 0
          ? errorMsgs.push(...errors)
          : result.push(Object.values(row));
      }

      const workerPath = path.resolve(getWorkerFile('bulkInsert'));

      await myWorker.createWorker(workerPath, {
        scopeBrandIds,
        user,
        contentType: type,
        properties,
        importHistoryId: importHistory._id,
        result,
        percentage: Number(((result.length / totalRows) * 100).toFixed(3))
      });

      await updateImportHistory({
        $inc: { failed: errorMsgs.length },
        $push: { errorMsgs }
      });

      await updateValidationValues();

      errorMsgs = [];
    } catch (e) {
      debugWorkers(e.message);
      throw e;
    }
  };

  importBulkStream({
    fileName,
    uploadType,
    bulkLimit: WORKER_BULK_LIMIT,
    handleBulkOperation
  });

  return { id: importHistory.id };
};

export const generateUid = () => {
  return (
    '_' +
    Math.random()
      .toString(36)
      .substr(2, 9)
  );
};
export const generatePronoun = value => {
  const pronoun = CUSTOMER_SELECT_OPTIONS.SEX.find(
    sex => sex.label.toUpperCase() === value.toUpperCase()
  );

  return pronoun ? pronoun.value : '';
};
