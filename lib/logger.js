/*
 *  LogDNA NPM Module
 *      - supports levels (Debug, Info, Notice, Warning, Error, Critical, Alert, Emerge)
 *      - supports Winston
 *      - supports Bunyan
 */

const axios = require('axios');
const clone = require('lodash.clonedeep');
const os = require('os');
const sizeof = require('object-sizeof');
const stringify = require('json-stringify-safe');
const validUrl = require('valid-url');
const querystring = require('querystring');

const Agent = require('agentkeepalive');

const util = require('util');
const debug = util.debuglog('logdna');

const configs = require('./configs');

var loggers = [];

const isInt = function(value) {
    return !isNaN(value) && ((parseFloat(value) | 0) === parseFloat(value));
};

const checkStringParam = (param, name, optional) => {
    if (optional && !param) return;
    if (!param || typeof param !== 'string') {
        throw new Error(`${name} is undefined or not passed as a String`);
    } else if (param.length > configs.MAX_INPUT_LENGTH) {
        throw new Error(`${name} cannot be longer than ${configs.MAX_INPUT_LENGTH} chars`);
    }
};

const isValidTimestamp = (timestamp) => {
    var valid = (new Date(timestamp)).getTime() > 0;
    if (!valid || Math.abs(timestamp - Date.now()) > configs.MS_IN_A_DAY) {
        debug('Error: The timestamp used is either invalid or not within one day. Date.now() will be used in its place.');
        return false;
    }
    return true;
};

function Logger(key, options) {
    if (!(this instanceof Logger)) {
        return new Logger(key, options);
    }

    checkStringParam(key, 'LogDNA Ingestion Key', false);
    checkStringParam(options.hostname, 'Hostname', true);
    checkStringParam(options.mac, 'MAC Address', true);
    checkStringParam(options.ip, 'IP Address', true);
    checkStringParam(options.level, 'Level', true);
    checkStringParam(options.app, 'App', true);
    checkStringParam(options.logdna_url, 'LogDNA URL', true);

    if (options.tags) {
        if (typeof options.tags === 'string') {
            options.tags = options.tags.split(',');
        }

        if (Array.isArray(options.tags)) {
            options.tags = options.tags
                .filter((tag) => tag !== '')
                .map((tag) => tag.trim())
                .join(',');
        } else {
            throw new Error('Tags should be passed as a String or an Array');
        }
    }

    if (options.timeout) {
        if (!isInt(options.timeout)) {
            throw new Error('Timeout must be an Integer');
        }
        if (options.timeout > configs.MAX_REQUEST_TIMEOUT) {
            throw new Error(`Timeout cannot be longer than ${configs.MAX_REQUEST_TIMEOUT}`);
        }
    }

    if (options.hostname && !configs.HOSTNAME_CHECK.test(options.hostname)) {
        throw new Error('Invalid hostname');
    }

    if (options.mac && !configs.MAC_ADDR_CHECK.test(options.mac)) {
        throw new Error('Invalid MAC Address format');
    }

    if (options.ip && !configs.IP_ADDR_CHECK.test(options.ip)) {
        throw new Error('Invalid IP Address format');
    }

    if (options.logdna_url && !validUrl.isUri(options.logdna_url)) {
        throw new Error('Invalid URL');
    }

    if (options.flushLimit && Number.isInteger(options.flushLimit)) {
        this._flushLimit = options.flushLimit;
    } else {
        this._flushLimit = configs.FLUSH_BYTE_LIMIT;
    }

    if (options.flushInterval && Number.isInteger(options.flushInterval)) {
        this._flushInterval = options.flushInterval;
    } else {
        this._flushInterval = options.FLUSH_INTERVAL;
    }

    this._max_length = options.max_length || true;
    this._index_meta = options.index_meta || false;
    this._url = options.logdna_url || configs.LOGDNA_URL;
    this._bufByteLength = 0;
    this._buf = [];

    this.source = {
        hostname: options.hostname || os.hostname()
        , app: options.app || 'default'
        , level: options.level || 'INFO'
        , env: options.env || undefined
        , tags: options.tags || undefined
    };

    var useHttps = configs.AGENT_PROTOCOL === 'https';

    this._req = {
        auth: { username: key }
        , agent: useHttps ? new Agent.HttpsAgent(configs.AGENT_SETTING) : new Agent(configs.AGENT_SETTING)
        , headers: clone(configs.DEFAULT_REQUEST_HEADER)
        , qs: {
            hostname: this.source.hostname
            , mac: options.mac || undefined
            , ip: options.ip || undefined
            , tags: this.source.tags || undefined
        }
        , timeout: options.timeout || configs.DEFAULT_REQUEST_TIMEOUT
        , withCredentials: options.with_credentials || configs.REQUEST_WITH_CREDENTIALS
        , useHttps: useHttps
    };
    this._req.headers.Authorization = 'Basic ' + Buffer.from(`${key}:`).toString('base64');

    loggers.push(this);
}

Logger.prototype.log = function(statement, opts) {
    this._err = false;
    if (typeof statement === 'object') {
        if (this.ambientMeta) {
            statement.ambientMeta = this.ambientMeta;
        }
        statement = JSON.parse(JSON.stringify(statement));
        statement = stringify(statement, null, 2, function() { return undefined; });
    }

    if (typeof statement !== 'object' && this.ambientMeta) {
        statement = `${JSON.stringify({message: statement, ambient_meta: this.ambientMeta})}`;
    }

    var message = {
        timestamp: Date.now()
        , line: statement
        , level: this.source.level
        , app: this.source.app
        , env: this.source.env
    };

    if (opts) {
        if (typeof opts === 'string') {
            if (opts.length > configs.MAX_INPUT_LENGTH) {
                debug('Level had more than ' + configs.MAX_INPUT_LENGTH + ' chars, was truncated');
                opts = opts.substring(0, configs.MAX_INPUT_LENGTH);
            }
            message.level = opts;
        } else {
            if (typeof opts !== 'object') {
                this._err = true;
                debug('Can only pass a String or JSON object as additional parameter');
            }
            message.level = opts.level || message.level;
            message.app = opts.app || message.app;
            message.env = opts.env || message.env;
            if (opts.timestamp && isValidTimestamp(opts.timestamp)) {
                message.timestamp = opts.timestamp;
            }
            if (opts.context && !opts.meta) {
                opts.meta = opts.context;
            }
            if (typeof opts.meta === 'object') {
                if (opts.index_meta || (opts.index_meta === undefined && this._index_meta)) {
                    message.meta = opts.meta;
                } else {
                    message.meta = stringify(opts.meta);
                }
            }
        }
    }

    if (this._err) {
        return this._err;
    }
    this._bufferLog(message);
};

Logger.prototype._bufferLog = function(message) {
    if (!message || !message.line) {
        debug('Ignoring empty message');
        return;
    }

    if (this._max_length && message.line.length > configs.MAX_LINE_LENGTH) {
        message.line = message.line.substring(0, configs.MAX_LINE_LENGTH) + ' (cut off, too long...)';
        debug('Line was longer than ' + configs.MAX_LINE_LENGTH + ' chars and was truncated.');
    }

    this._bufByteLength += sizeof(message);

    debug('Buffering message: %s', message.line);
    this._buf.push(message);

    if (this._bufByteLength >= this._flushLimit) {
        debug('Buffer size meets (or exceeds) flush limit.  Immediately flushing');
        this._flush((err) => {
            if (err) {
                debug('Received an error while flushing...' + err);
            }
        });
    }

    if (!this._flusher) {
        debug('No scheduled flush. Scheduling for %d ms from now.', configs.FLUSH_INTERVAL);
        this._flusher = setTimeout(() => {
            this._flush((err) => { debug(err); });
        }, this._flushInterval);
    }
};

Logger.prototype.addProperty = function (meta) {
    this.ambientMeta = meta;
};

Logger.prototype.removeProperty = function () {
    this.ambientMeta = null;
};

Logger.prototype._flush = function(callback) {
    if (!callback || typeof callback !== 'function') {
        throw new Error('flush function expects a callback');
    }
    if (this._buf.length === 0) {
        debug('Nothing to flush');
        return callback();
    }

    const data = stringify({ e: 'ls', ls: this._buf });

    // BEFORE we clear the buffer, capture the lines being flushed for debug output
    var dbgLines = this._buf.map(function(msg) { return msg.line; });

    this._bufByteLength = 0;
    this._buf.length = 0;

    clearTimeout(this._flusher);
    this._flusher = null;

    this._req.qs.now = Date.now();
    var _config = {
        method: 'post'
        , url: this._url + '?' + querystring.stringify(this._req.qs)
        , headers: this._req.headers
        , data: data
        , timeout: this._req.timeout
        , withCredentials: this._req.withCredentials
        , json: true
    };
    if (this._req.useHttps) {
        _config.httpsAgent = this._req.agent;
    } else {
        _config.httpAgent = this._req.agent;
    }

    axios(_config)
        .then(function(response) {
            if (response && response.status === 200) {
                return callback(null, {
                    lines: dbgLines
                    , httpStatus: response.status
                    , body: response
                });
            }
            return callback(`Unsuccessful request. Status text: ${response ? response.statusText : ''}`);
        })
        .catch(function(err) {
            let message = 'An error occured while making the request.';
            if (err && err.response) {
                message += ` Response status code: ${err.response.status} ${err.response.statusText}`;
            }
            return callback(message);
        });
};


/*
 *  Populate short-hand for each supported Log Level
 */
configs.LOG_LEVELS.forEach(function(level) {
    var l = level.toLowerCase();
    Logger.prototype[l] = function(statement, opts) {
        opts = opts || {};
        opts.level = level;
        this.log(statement, opts);
    };
});

const flushAll = function(cb) {
    if (!cb || typeof cb !== 'function') {
        cb = debug;
    }
    const errors = [];
    loggers.forEach((logger) => {
        logger._flush((err) => {
            if (err) {
                errors.push(err);
            }
        });
    });

    if (errors.length > 0) {
        return cb(`The following errors happened while flushing all loggers: ${errors}`);
    }
    return cb();
};

exports.Logger = Logger;

exports.createLogger = function(key, options) {
    var next = new Logger(key, options);
    return next;
};

exports.flushAll = flushAll;
exports.cleanUpAll = function(cb) {
    flushAll(cb);
    loggers = [];
};
