import merge from 'lodash.merge'
import logger from '@wdio/logger'
import {
    WebDriverProtocol, MJsonWProtocol, JsonWProtocol, AppiumProtocol, ChromiumProtocol,
    SauceLabsProtocol, SeleniumProtocol
} from '@wdio/protocols'

import WebDriverRequest from './request'
import command from './command'

const log = logger('webdriver')

const BROWSER_DRIVER_ERRORS = [
    'unknown command: wd/hub/session', // chromedriver
    'HTTP method not allowed', // geckodriver
    "'POST /wd/hub/session' was not found.", // safaridriver
    'Command not found' // iedriver
]

/**
 * start browser session with WebDriver protocol
 */
export async function startWebDriverSession (params) {
    /**
     * the user could have passed in either w3c style or jsonwp style caps
     * and we want to pass both styles to the server, which means we need
     * to check what style the user sent in so we know how to construct the
     * object for the other style
     */
    const [w3cCaps, jsonwpCaps] = params.capabilities && params.capabilities.alwaysMatch
        /**
         * in case W3C compliant capabilities are provided
         */
        ? [params.capabilities, params.capabilities.alwaysMatch]
        /**
         * otherwise assume they passed in jsonwp-style caps (flat object)
         */
        : [{ alwaysMatch: params.capabilities, firstMatch: [{}] }, params.capabilities]

    const sessionRequest = new WebDriverRequest(
        'POST',
        '/session',
        {
            capabilities: w3cCaps, // W3C compliant
            desiredCapabilities: jsonwpCaps // JSONWP compliant
        }
    )

    let response
    try {
        response = await sessionRequest.makeRequest(params)
    } catch (err) {
        log.error(err)
        const message = getSessionError(err, params)
        throw new Error('Failed to create session.\n' + message)
    }
    const sessionId = response.value.sessionId || response.sessionId

    /**
     * save original set of capabilities to allow to request the same session again
     * (e.g. for reloadSession command in WebdriverIO)
     */
    params.requestedCapabilities = { w3cCaps, jsonwpCaps }

    /**
     * save actual receveived session details
     */
    params.capabilities = response.value.capabilities || response.value

    return sessionId
}

/**
 * check if WebDriver requests was successful
 * @param  {Object}  body  body payload of response
 * @return {Boolean}       true if request was successful
 */
export function isSuccessfulResponse (statusCode, body) {
    /**
     * response contains a body
     */
    if (!body || typeof body.value === 'undefined') {
        log.debug('request failed due to missing body')
        return false
    }

    /**
     * ignore failing element request to enable lazy loading capability
     */
    if (
        body.status === 7 && body.value && body.value.message &&
        (
            body.value.message.toLowerCase().startsWith('no such element') ||
            // Appium
            body.value.message === 'An element could not be located on the page using the given search parameters.' ||
            // Internet Explorter
            body.value.message.toLowerCase().startsWith('unable to find element')
        )
    ) {
        return true
    }

    /**
     * if it has a status property, it should be 0
     * (just here to stay backwards compatible to the jsonwire protocol)
     */
    if (body.status && body.status !== 0) {
        log.debug(`request failed due to status ${body.status}`)
        return false
    }

    const hasErrorResponse = body.value && (body.value.error || body.value.stackTrace || body.value.stacktrace)

    /**
     * check status code
     */
    if (statusCode === 200 && !hasErrorResponse) {
        return true
    }

    /**
     * if an element was not found we don't flag it as failed request because
     * we lazy load it
     */
    if (statusCode === 404 && body.value && body.value.error === 'no such element') {
        return true
    }

    /**
     * that has no error property (Appium only)
     */
    if (hasErrorResponse) {
        log.debug('request failed due to response error:', body.value.error)
        return false
    }

    return true
}

/**
 * creates the base prototype for the webdriver monad
 */
export function getPrototype ({ isW3C, isChrome, isMobile, isSauce, isSeleniumStandalone }) {
    const prototype = {}
    const ProtocolCommands = merge(
        /**
         * if mobile apply JSONWire and WebDriver protocol because
         * some legacy JSONWire commands are still used in Appium
         * (e.g. set/get geolocation)
         */
        isMobile
            ? merge({}, JsonWProtocol, WebDriverProtocol)
            : isW3C ? WebDriverProtocol : JsonWProtocol,
        /**
         * only apply mobile protocol if session is actually for mobile
         */
        isMobile ? merge({}, MJsonWProtocol, AppiumProtocol) : {},
        /**
         * only apply special Chrome commands if session is using Chrome
         */
        isChrome ? ChromiumProtocol : {},
        /**
         * only Sauce Labs specific vendor commands
         */
        isSauce ? SauceLabsProtocol : {},
        /**
         * only apply special commands when running tests using
         * Selenium Grid or Selenium Standalone server
         */
        isSeleniumStandalone ? SeleniumProtocol : {}
    )

    for (const [endpoint, methods] of Object.entries(ProtocolCommands)) {
        for (const [method, commandData] of Object.entries(methods)) {
            prototype[commandData.command] = { value: command(method, endpoint, commandData, isSeleniumStandalone) }
        }
    }

    return prototype
}

/**
 * helper method to determine the error from webdriver response
 * @param  {Object} body body object
 * @return {Object} error
 */
export function getErrorFromResponseBody (body) {
    if (!body) {
        return new Error('Response has empty body')
    }

    if (typeof body === 'string' && body.length) {
        return new Error(body)
    }

    if (typeof body !== 'object' || (!body.value && !body.error)) {
        return new Error('unknown error')
    }

    return new CustomRequestError(body)
}

//Exporting for testability
export class CustomRequestError extends Error {
    constructor(body) {
        const errorObj = body.value || body
        super(errorObj.message || errorObj.class || 'unknown error')
        if (errorObj.error) {
            this.name = errorObj.error
        } else if (errorObj.message && errorObj.message.includes('stale element reference')) {
            this.name = 'stale element reference'
        }
    }
}

/**
 * return all supported flags and return them in a format so we can attach them
 * to the instance protocol
 * @param  {Object} options   driver instance or option object containing these flags
 * @return {Object}           prototype object
 */
export function getEnvironmentVars({ isW3C, isMobile, isIOS, isAndroid, isChrome, isSauce, isSeleniumStandalone }) {
    return {
        isW3C: { value: isW3C },
        isMobile: { value: isMobile },
        isIOS: { value: isIOS },
        isAndroid: { value: isAndroid },
        isChrome: { value: isChrome },
        isSauce: { value: isSauce },
        isSeleniumStandalone: { value: isSeleniumStandalone }
    }
}

/**
 * Decorate the params object with host updates based on the presence of
 * directConnect capabilities in the new session response. Note that this
 * mutates the object.
 * @param  {Object} params    post-new-session params used to build driver
 */
export function setupDirectConnect(params) {
    const { directConnectProtocol, directConnectHost, directConnectPort,
        directConnectPath } = params.capabilities
    if (directConnectProtocol && directConnectHost && directConnectPort &&
        (directConnectPath || directConnectPath === '')) {
        log.info('Found direct connect information in new session response. ' +
            `Will connect to server at ${directConnectProtocol}://` +
            `${directConnectHost}:${directConnectPort}/${directConnectPath}`)
        params.protocol = directConnectProtocol
        params.hostname = directConnectHost
        params.port = directConnectPort
        params.path = directConnectPath
    }
}

/**
 * get human readable message from response error
 * @param {Error} err response error
 */
export const getSessionError = (err, params) => {
    // browser driver / service is not started
    if (err.code === 'ECONNREFUSED') {
        return `Unable to connect to "${params.protocol}://${params.hostname}:${params.port}${params.path}", make sure browser driver is running on that address.` +
            '\nIf you use services like chromedriver see initialiseServices logs above or in wdio.log file as the service might had problems to start the driver.'
    }

    if (err.message === 'unhandled request') {
        return 'The browser driver couldn\'t start the session. Make sure you have set the "path" correctly!'
    }

    if (!err.message) {
        return 'See wdio.* logs for more information.'
    }

    // wrong path: selenium-standalone
    if (err.message.includes('Whoops! The URL specified routes to this help page.')) {
        return "It seems you are running a Selenium Standalone server and point to a wrong path. Please set `path: '/wd/hub'` in your wdio.conf.js!"
    }

    // wrong path: chromedriver, geckodriver, etc
    if (BROWSER_DRIVER_ERRORS.some(m => err.message.includes(m))) {
        return "Make sure to set `path: '/'` in your wdio.conf.js!"
    }

    // edge driver on localhost
    if (err.message.includes('Bad Request - Invalid Hostname') && err.message.includes('HTTP Error 400')) {
        return "Run edge driver on 127.0.0.1 instead of localhost, ex: --host=127.0.0.1, or set `hostname: 'localhost'` in your wdio.conf.js"
    }

    const w3cCapMessage = '\nMake sure to add vendor prefix like "goog:", "appium:", "moz:", etc to non W3C capabilities.' +
        '\nSee more https://www.w3.org/TR/webdriver/#capabilities'

    // Illegal w3c capability passed to selenium standalone
    if (err.message.includes('Illegal key values seen in w3c capabilities')) {
        return err.message + w3cCapMessage
    }

    // wrong host/port, port in use, illegal w3c capability passed to selenium grid
    if (err.message === 'Response has empty body') {
        return 'Make sure to connect to valid hostname:port or the port is not in use.' +
            '\nIf you use a grid server ' + w3cCapMessage
    }

    return err.message
}
