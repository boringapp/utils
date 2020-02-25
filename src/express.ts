import { Request, Response, NextFunction, RequestHandler, Router } from 'express';
import {
  BAD_REQUEST, NOT_FOUND, OK, INTERNAL_SERVER_ERROR,
  getStatusText,
} from 'http-status-codes';

import { HttpError } from './error';
import errorHandler from './errorHandler';

// ---------------------------------------------------
// ----------------------Helpers----------------------
// ---------------------------------------------------

interface OriginalQuery {
  readonly select?: string;
  readonly populate?: string;
}
interface Query {
  readonly select: ReadonlyArray<string>;
  readonly populate: ReadonlyArray<string>;
}
interface OriginalListQuery {
  readonly sort?: string;
  readonly order?: string;
  readonly skip?: number;
  readonly limit?: number;
  readonly select?: string;
  readonly populate?: string;
  readonly search?: string;
  readonly q?: string;
  readonly filter?: string;
  readonly [key: string]: any;  // tslint:disable-line: no-mixed-interface
}
interface ListQuery {
  readonly query: {
    readonly [key: string]: string | ReadonlyArray<string> | any;
  };
  readonly select: ReadonlyArray<string>;
  readonly populate: ReadonlyArray<string>;
  readonly sort: string;
  readonly skip: number;
  readonly limit: number;
}

const DEFAULT_QUERY: Query = {
  select: [],
  populate: [],
};
const DEFAULT_LIST_QUERY: ListQuery = {
  query: {},
  select: [],
  populate: [],
  sort: 'createdAt',
  skip: 0,
  limit: 25,
};

const parseSearchQuery = (searchBy: string, keyword: string) => {
  if (!searchBy.trim() || !keyword.trim()) {
    return {};
  }

  const query = searchBy.trim().split(',').reduce(
    (prev: ReadonlyArray<any>, key) => !key.trim() ? prev : prev.concat({
      [key.trim()]: new RegExp(keyword.trim(), 'gi'),
    }),
    [],
  );

  if (query.length === 0) {
    return {};
  }

  return query.length === 1 ? query[0] : { $or: query };
};

const parseFilterQuery = (filterBy: string, values: { readonly [key: string]: string }) => {
  if (!filterBy.trim()) {
    return {};
  }

  return filterBy.trim().split(',').reduce(
    (prev: { readonly [key: string]: any }, key) => {
      if (!key || !key.trim()) {
        return prev;
      }

      if (!values[key.trim()].trim()) {
        return {
          ...prev,
          $or: [
            ...(prev['$or'] || []),
            { [key.trim()]: { $exists: false } },
            { [key.trim()]: null },
          ],
        };
      }

      const valuesArray = values[key.trim()].trim().split(',');

      return {
        ...prev,
        [key.trim()]: valuesArray.length === 1
          ? valuesArray[0]
          : { $in: valuesArray.map(v => v.trim()) },
      };
    },
    {},
  ) as any;
};

const parseSelect = (select: string) => {
  return select.split(',').filter(item => !!item);
};

const parsePopulate = (populate: string) => {
  return populate.split(',').filter(item => !!item);
};

const parseSort = (sort: string, order: string) => {
  return order === 'desc' ? `-${sort.trim()}` : sort.trim();
};

const parseQuery = ({
  select = '',
  populate = '',
}: OriginalQuery): Query => ({
  select: parseSelect(select),
  populate: parsePopulate(populate),
});

const parseListQuery = (listQuery: OriginalListQuery): ListQuery => {
  const {
    search = '', q = '',
    filter = '', ...filterValues
  } = listQuery;
  const {
    select = '',
    populate = '',
    sort = 'createdAt', order = 'asc',
    skip = 0, limit = 25,
  } = listQuery;
  const { $or: searchOr, ...searchQuery } = parseSearchQuery(search, q);
  const { $or: filterOr, ...filterQuery } = parseFilterQuery(filter, filterValues);

  const $and = [];  // tslint:disable-line: readonly-array
  if (searchOr) {
    $and.push({ $or: searchOr });
  }
  if (filterOr) {
    $and.push({ $or: filterOr });
  }

  return {
    query: {
      ...searchQuery,
      ...filterQuery,
      ...($and.length > 0 ? { $and } : {}),
    },
    select: parseSelect(select),
    populate: parsePopulate(populate),
    sort: parseSort(sort, order),
    skip: +skip,
    limit: +limit,
  };
};

// ---------------------------------------------------
// -----------------Express Middleware----------------
// ---------------------------------------------------

/**
 * Parse request's query to the mongoose compatible query
 * @param req Express Request object
 * @param _ Express Response object
 * @param next Express Next function
 */
const validateQuery = (req: Request, _: Response, next: NextFunction) => {
  try {
    const myQuery = parseQuery(req.query);
    Object.assign(req, { myQuery });  // tslint:disable-line: no-object-mutation

    next();
  } catch (err) {
    next(new HttpError(BAD_REQUEST, err));
  }
};

/**
 * Parse request's query to the mongoose compatible query
 * @param req Express Request object
 * @param _ Express Response object
 * @param next Express Next function
 */
const validateListQuery = (req: Request, _: Response, next: NextFunction) => {
  try {
    const myQuery = parseListQuery(req.query);
    Object.assign(req, { myQuery });  // tslint:disable-line: no-object-mutation

    next();
  } catch (err) {
    next(new HttpError(BAD_REQUEST, err));
  }
};

/**
 * An Express RequestHandler wrapper that throws error if invalid,
 * otherwise parses the request's body to the desired one
 * @param validate Validation function
 */
const validateBody = (validate: Function): RequestHandler => {
  return (req: Request, _: Response, next: NextFunction) => {
    try {
      const myBody = validate(req.body);
      Object.assign(req, { myBody }); // tslint:disable-line: no-object-mutation

      next();
    } catch (err) {
      next(new HttpError(BAD_REQUEST, err));
    }
  };
};

/**
 * An Express RequestHandler that handles the 404 Not Found error
 * @param _ Express Request object
 * @param __ Express Response object
 * @param next Express Next function
 */
const handleNotFound = (_: Request, __: Response, next: NextFunction) => {
  next(new HttpError(NOT_FOUND, 'Resource not found'));
};

/**
 * An Express RequestHandler that responses error info to the client
 * @param err Http Error object
 * @param _ Express Request object
 * @param res Express Response object
 * @param __ Express Next function
 */
const handleErrors = (err: HttpError, _: Request, res: Response, __: NextFunction) => {
  errorHandler.handle(err);

  try {
    // check if status code exists
    getStatusText(err.code);

    res.status(err.code).send(err);
  } catch (error) {
    res.status(INTERNAL_SERVER_ERROR).send(err);
  }
};

/**
 * An Express RequestHandler that responses OK for health checking
 * @param _ Express Request object
 * @param res Express Response object
 */
const handleHealthCheck = (_: Request, res: Response) => {
  res.status(OK).send('OK');
};

/**
 * An Express Middleware mounted /health endpoint for health checking
 */
const health = () => {
  const router = Router();

  router.get('/health', handleHealthCheck);

  return router;
};

export {
  OriginalQuery,
  Query,
  OriginalListQuery,
  ListQuery,

  DEFAULT_QUERY,
  DEFAULT_LIST_QUERY,

  parseQuery,
  parseListQuery,

  validateQuery,
  validateListQuery,
  validateBody,

  handleNotFound,
  handleErrors,
  handleHealthCheck,

  health,
};
