const uuidv1 = require('uuid/v1'),
    request = require('request'),
    DispatcherClass = require('../dispatcher/dispatcher').Dispatcher;
const config = require('../envVariables');
const axios =  require("axios");
const _ =  require("lodash");

// TODO: Make this efficient. Implementation to be similar to typesafe config. Right now one configuration holds 
// together all supported transport configurations

class TelemetryService {
    constructor(Dispatcher, config) {
        this.config = config;
        this.dispatcher = this.config.localStorageEnabled === 'true' ? new Dispatcher(config) : undefined;
    }
    dispatch(req, res) {
        const message = req.body;
        message.did = req.get('x-device-id');
        message.channel = req.get('x-channel-id');
        message.pid = req.get('x-app-id');
        if (!message.mid) message.mid = uuidv1();
        message.syncts = new Date().getTime();
        const data = JSON.stringify(message);
        if (this.config.localStorageEnabled === 'true' || this.config.telemetryProxyEnabled === 'true') {
            if (this.config.localStorageEnabled === 'true' && this.config.telemetryProxyEnabled !== 'true') {
                // Store locally and respond back with proper status code
                console.log(`${Date()} :: Calling dispatcher.dispatch :: ===> "`)
                this.dispatcher.dispatch(message.mid, data).then((result) => {
                    this.sendSuccess(res, { id: 'api.telemetry' });
                }).catch((err) => {
                    this.sendError(res, { id: 'api.telemetry', params: { err: err } });
                });
            } else if (this.config.localStorageEnabled === 'true' && this.config.telemetryProxyEnabled === 'true') {
                // Store locally and proxy to the specified URL. If the proxy fails ignore the error as the local storage is successful. Do a sync later
                const options = this.getProxyRequestObj(req, data);
                request.post(options, (err, data) => {
                    if (err) console.error('Proxy failed:', err);
                    else console.log('Proxy successful!  Server responded with:', data.body);
                });
                this.dispatcher.dispatch(message.mid, data, this.getRequestCallBack(req, res));
            } else if (this.config.localStorageEnabled !== 'true' && this.config.telemetryProxyEnabled === 'true') {
                // Just proxy
                const options = this.getProxyRequestObj(req, data);
                request.post(options, this.getRequestCallBack(req, res));
            }
        } else {
            this.sendError(res, { id: 'api.telemetry', params: { err: 'Configuration error' } });
        }
    }
    health(req, res) {
        if (this.config.localStorageEnabled === 'true') {
            this.dispatcher.health((healthy) => {
                if (healthy)
                    this.sendSuccess(res, { id: 'api.health' });
                else
                    this.sendError(res, { id: 'api.health', params: { err: 'Telemetry API is unhealthy' } });
            })
        } else if (this.config.telemetryProxyEnabled === 'true') {
            this.sendSuccess(res, { id: 'api.health' });
        } else {
            this.sendError(res, { id: 'api.health', params: { err: 'Configuration error' } });
        }
    }
    getRequestCallBack(req, res) {
        return (err, data) => {
            if (err) {
                console.log('error', err);
                this.sendError(res, { id: 'api.telemetry', params: { err: err } });
            }
            else {
                this.sendSuccess(res, { id: 'api.telemetry' });
            }
        }
    }
    sendError(res, options) {
        const resObj = {
            id: options.id,
            ver: options.ver || '1.0',
            ets: new Date().getTime(),
            params: options.params || {},
            responseCode: options.responseCode || 'SERVER_ERROR'
        }
        res.status(options.statusCode || 500);
        res.json(resObj);
    }
    sendSuccess(res, options) {
        const resObj = {
            id: options.id,
            ver: options.ver || '1.0',
            ets: new Date().getTime(),
            params: options.params || {},
            responseCode: options.responseCode || 'SUCCESS',
            result: options.result || {}
        }
        res.status(200);
        res.json(resObj);
    }
    getProxyRequestObj(req, data) {
        const headers = { 'authorization': 'Bearer ' + config.proxyAuthKey };
        if (req.get('content-type')) headers['content-type'] = req.get('content-type');
        if (req.get('content-encoding')) headers['content-encoding'] = req.get('content-encoding');
        return {
            url: this.config.proxyURL,
            headers: headers,
            body: data
        };
    }
    getMetricsData(req, res) {
        this.dispatcher.getMetricsData(req, this.getMetricsRequestCallBack(req, res));
    }
    getMetricsRequestCallBack(req, res) {
        return (err, data) => {
            if (err) {
                this.sendError(res, { id: req?.id || 'api.telemetry.metrics', params: { err: err } });
            }else {
                this.sendSuccess(res, { 
                    id: req?.id || 'api.telemetry.metrics', 
                    params: {
                        resmsgid: uuidv1(),
                        msgid: req?.body?.params?.msgid || uuidv1()
                    },
                    result: data
                });
            }
        }
    }
    async fetchDashboardToken(req, res) {
        const dashboardIds = req.body?.request?.dashboardIds
        if(!dashboardIds || _.isEmpty(dashboardIds)){
            return this.sendError(res, { 
                id: req?.id || 'api.telemetry.access.token', 
                statusCode: 400, 
                responseCode: 'ERR_BAD_REQUEST',
                params: {
                    errmsg: "dashboardIds is requird"
                } 
            });
        }
        try {
            const accessTokenRes = await this.fetchAccessToken(req, res)
            const accessToken = accessTokenRes.data?.access_token;
            const resources = []
            _.forEach(dashboardIds, function(value) {
                resources.push({
                    "type": "dashboard",
                    "id": value
                  })
            });
            
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            }
            
            const response = await axios.post(`${config.supersethost}/api/v1/security/guest_token`, 
                {
                    "resources": resources, 
                    "rls": [], "user": {}
                }, {headers}
            );

            if(!response.data?.token) {
                return this.sendError(res, { id: req?.id || 'api.telemetry.access.token', params: { err: 'Token genrartion failed.'} });
            }

            this.sendSuccess(res, { 
                id: req?.id || 'api.telemetry.access.token', 
                params: {
                    resmsgid: uuidv1(),
                    msgid: req?.body?.params?.msgid || uuidv1()
                },
                result: response.data
            });
            
        } catch (error) {
            console.error("fetchGuestToken error ", error.message)
            this.sendError(res, { id: req?.id || 'api.telemetry.access.token', params: { err: error.message, errorCode:  error.code} });
        }
    }
    async fetchAccessToken(req, res){
        const response = await axios.post(`${config.supersethost}/api/v1/security/login`, {
            "username": config.supersetAdminUser,
            "password": config.supersetAdminPass,
            "provider": "db",
            "refresh": true,
        });
        return response;
    }
}

module.exports = new TelemetryService(DispatcherClass, config);
