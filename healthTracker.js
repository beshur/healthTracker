const request = require('request');
const EventEmitter = require('events');
const { URL } = require('url');

class trackItem extends EventEmitter {
	/**
	 * @param {Object[]} props
	 * @param {string} props.name
	 * @param {string} props.host
	 * @param {Object} logger
	 */
	constructor(props, logger) {
		super(props);
		this.PATH = '/health-check';
		this.props = props;
		this.logger = logger;
		this.status = '';
		this.id = 0;
		this.retries = 0;
		this.lastOkTime = 0;
		this.escalated = 0;

		this.getStatus.bind(this);
		this.check.bind(this);
	}

	setId(id) {
		this.id = id;
	}

	check() {
		let url = new URL(this.PATH, this.props.host);
		request(url.href, (error, response, body) => {
			if (error) {
				this._onError(error, response, body);
			} else if (this._checkForError(response)) {
				this._onError(error, response, body);
			} else {
				this._onOk(response, body);
			}
		});
	}

	_checkForError(response) {
		let error = false;
		if (/(^5)|(^4)/.test(response.statusCode)) {
			error = true;
		}
		return error;
	}

	getStatus() {
		return {
			id: this.id,
			name: this.props.name,
			host: this.props.host,
			retries: this.retries,
			status: this.status,
			lastOkTime: this.lastOkTime,
			escalated: this.escalated
		};
	}

	escalate(callback) {
		this.escalated = Date.now();
		if (typeof callback !== 'function') {
			this.logger.error(this.name, 'ERROR: No escalation callback provided');
		} else {
			callback();
		}
	}

	_onOk(response) {
		this.logger.log(this.props.name, 'OK');
		this.retries = 0;
		this.status = 'OK';
		this.lastOkTime = Date.now();
		this.escalated = 0;
		this.emit('onOk', this.getStatus());
	}

	_onError(error) {
		this.logger.warn(this.props.name, 'ERROR', error);
		this.retries++;
		this.status = 'ERROR';

		this.emit('onError', this.getStatus());
	}
}
/**
 * Main health tracker class
 */
class healthTracker extends EventEmitter {
	constructor(props, logger) {
		super(props);
		this.props = props;
		this.logger = logger || console;
		this.items = {};
		this.idIncrement = 0;
		this.checkIntervalRef;

		this.addServiceMiddleWare.bind(this);
	}

	get registerKey() {
		return this.options.registerKey;
	}

	get checkInterval() {
		return this.options.checkInterval;
	}

	/**
	 * @param {Object[]} options
	 * @param {string} options.registerKey - verification
	 * @param {string} options.serviceOk - callback for OK status of service
	 * @param {string} options.serviceDown - callback for initial service down
	 * @param {string} options.serviceDownEscalate - callback for the case when service down for n retries
	 * @param {int} options.checkInterval - interval length (in minutes, >1) to check the services
	 * @param {int} options.serviceDownRetriesBeforeEscalate - number of health-check retries before escalating
	 */
	configure(options) {
		if (!options.registerKey) {
			throw new Error('registerKey is mandatory');
		}
		if (!options.serviceDown) {
			throw new Error('serviceDown callback is mandatory');
		}
		if (!options.serviceDownEscalate) {
			throw new Error('serviceDownEscalate callback is mandatory');
		}
		if (!options.serviceDownRetriesBeforeEscalate) {
			options.serviceDownRetriesBeforeEscalate = 5;
		}
		if (!options.serviceOk) {
			options.serviceOk = () => {};
		}
		if (options.checkInterval) {
			if (options.checkInterval < 1) {
				options.checkInterval = 1;
			}
		} else {
			options.checkInterval = 1;
		}
		// options.checkInterval = options.checkInterval * 60 * 1000;
		options.checkInterval = 1000;
		this.options = options;
		this.start();
	}

	start() {
		this.checkIntervalRef = setInterval(this._check.bind(this), this.checkInterval);
	}

	stop() {
		this.checkIntervalRef = null;
	}

	status() {
		let result = [];
		for (let prop in this.items) {
			result.push(this.items[prop].getStatus());
		}
		return result;
	}

	addServiceMiddleWare(req, res, next) {
		if (!this._checkRegisterKey(req.params.registerKey)) {
			res.status(403).json({error: 'Wrong register key'});
		}
		let serviceAdded = this.addService(req.body);
		if (typeof serviceAdded === 'integer') {
			res.status(200).json({'error': null, 'registered': true});
		} else {
			this.logger.error('addServiceMiddleWare: not added');
			res.status(401).json({'error': serviceAdded});
		}
	}

	addService(options) {
		let unique = true;
		for (let prop in this.items) {
			if (this.items[prop].host === options.host) {
				unique = false;
			}
		}
		if (!unique) {
			let errorText = `Service ${options.host} already added`;
			this.logger.error(errorText);
			return errorText;
		}
		let item = new trackItem(options, this.logger);

		item.on('onOk', this._onServiceOk.bind(this));
		item.on('onError', this._onServiceError.bind(this));
		this.idIncrement++;
		this.items[this.idIncrement] = item;
		item.setId(this.idIncrement);
		return this.idIncrement;
	}

	_check() {
		for (let prop in this.items) {
			this.items[prop].check();
		}
	}

	_onServiceOk(event) {
		this.logger.log('ok', event.id);
		this.options.serviceOk(event);
	}

	_onServiceError(event) {
		this.logger.warn('error', event);
		if (event.retries >= this.options.serviceDownRetriesBeforeEscalate) {
			if (!event.escalated) {
				this.items[event.id].escalate(this.options.serviceDownEscalate);
			}
		} else {
			this.options.serviceDown(event);
		}
	}

	_checkRegisterKey(key) {
		return key === this.registerKey;
	}
}

module.exports = new healthTracker();