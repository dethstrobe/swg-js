/**
 * Copyright 2018 The Subscribe with Google Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ActivityIframePort} from '../components/activities';
import {
  AnalyticsEvent,
  EventOriginator,
  EventParams,
  FinishedLoggingResponse,
} from '../proto/api_messages';
import {AnalyticsService} from './analytics-service';
import {ClientEventManager} from './client-event-manager';
import {ConfiguredRuntime} from './runtime';
import {Constants} from '../utils/constants';
import {ExperimentFlags} from './experiment-flags';
import {PageConfig} from '../model/page-config';
import {XhrFetcher} from './fetcher';
import {feUrl} from './services';
import {getStyle} from '../utils/style';
import {setExperimentsStringForTesting} from './experiments';
import {toTimestamp} from '../utils/date-utils';

const URL = 'www.news.com';

describes.realWin('AnalyticsService', {}, (env) => {
  let src;
  let activityPorts;
  let activityIframePort;
  let analyticsService;
  let pageConfig;
  let runtime;
  let eventManagerCallback;
  let pretendPortWorks;
  let loggedErrors;
  let eventsLoggedToService;
  let storageMock;

  const productId = 'pub1:label1';
  const defEventType = AnalyticsEvent.IMPRESSION_PAYWALL;
  const event = {
    eventType: defEventType,
    eventOriginator: EventOriginator.SWG_CLIENT,
    isFromUserAction: null,
    additionalParameters: {},
  };

  const IFRAME_STYLES = {
    opacity: '0',
    position: 'absolute',
    top: '-10px',
    left: '-10px',
    height: '1px',
    width: '1px',
  };

  beforeEach(() => {
    setExperimentsStringForTesting('');
    eventsLoggedToService = [];

    // Work around `location.search` being non-configurable,
    // which means Sinon can't stub it normally.
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Cant_redefine_property
    env.win = Object.assign({}, env.win, {
      location: {
        search: '?utm_source=scenic&utm_medium=email&utm_campaign=campaign',
      },
    });

    sandbox
      .stub(env.win.document, 'referrer')
      .get(() => 'https://scenic-2017.appspot.com/landing.html');

    sandbox
      .stub(XhrFetcher.prototype, 'sendBeacon')
      .callsFake((unusedUrl, message) => {
        eventsLoggedToService.push(message);
      });

    sandbox
      .stub(ClientEventManager.prototype, 'registerEventListener')
      .callsFake((callback) => (eventManagerCallback = callback));

    src = '/serviceiframe';
    pageConfig = new PageConfig(productId);
    runtime = new ConfiguredRuntime(env.win, pageConfig);
    activityPorts = runtime.activities();
    sandbox.stub(runtime.doc(), 'getRootNode').callsFake(() => {
      return {
        querySelector: () => {
          return {href: URL};
        },
      };
    });
    analyticsService = new AnalyticsService(runtime, runtime.fetcher_);
    storageMock = sandbox.mock(runtime.storage());
    activityIframePort = new ActivityIframePort(
      analyticsService.getElement(),
      feUrl(src),
      runtime
    );
    pretendPortWorks = true;
    sandbox.stub(activityPorts, 'openIframe').callsFake(() => {
      if (pretendPortWorks) {
        return Promise.resolve(activityIframePort);
      }
      return Promise.reject('Could not open iframe');
    });

    sandbox
      .stub(activityIframePort, 'whenReady')
      .callsFake(() => Promise.resolve(true));

    sandbox.stub(console, 'log').callsFake((error) => {
      loggedErrors.push(error);
    });
    loggedErrors = [];
  });

  describe('Construction', () => {
    it('should be listening for events from events manager', () => {
      expect(eventManagerCallback).to.not.be.null;
    });

    it('should have analyticsService constructed', () => {
      const activityIframe = analyticsService.getElement();
      const transactionId = analyticsService.getTransactionId();
      expect(analyticsService.getTransactionId()).to.equal(transactionId);
      expect(analyticsService.getTransactionId()).to.match(
        /^.{8}-.{4}-.{4}-.{4}-.{12}$/g
      );
      expect(activityIframe.nodeType).to.equal(1);
      expect(activityIframe.nodeName).to.equal('IFRAME');
      for (const key in IFRAME_STYLES) {
        if (typeof IFRAME_STYLES[key] === 'string') {
          expect(getStyle(activityIframe, key)).to.equal(IFRAME_STYLES[key]);
        }
      }
      const txId = 'tx-id-101';
      analyticsService.setTransactionId(txId);
      expect(analyticsService.getTransactionId()).to.equal(txId);
      expect(analyticsService.getContext().getUrl()).to.equal(URL);
    });

    it('should close', () => {
      const activityIframe = analyticsService.getElement();
      expect(activityIframe.parentNode).to.equal(runtime.doc().getBody());
      analyticsService.close();
      expect(activityIframe.parentNode).to.be.null;
    });
  });

  describe('Communications', () => {
    let iframeCallback;
    let expectOpenIframe;

    beforeEach(() => {
      iframeCallback = null;
      sandbox
        .stub(activityIframePort, 'on')
        .callsFake((constructor, callback) => {
          if (constructor === FinishedLoggingResponse) {
            iframeCallback = callback;
          }
        });
      expectOpenIframe = false;
    });
    afterEach(async () => {
      // Ensure that analytics service registers a callback to listen for when
      // logging is finished.
      expect(iframeCallback).to.not.be.null;
      if (expectOpenIframe) {
        expect(activityPorts.openIframe).to.have.been.calledOnce;
        const args = activityPorts.openIframe.getCall(0).args;
        expect(args[0].nodeName).to.equal('IFRAME');
        expect(args[1]).to.equal(feUrl(src));
        expect(args[2]).to.be.null;
        expect(args[3]).to.be.true;
      }
    });

    it('should call openIframe after client event', () => {
      analyticsService.setReadyForLogging();
      analyticsService.handleClientEvent_(event);
      expectOpenIframe = true;
      return activityIframePort.whenReady();
    });

    it('should call openIframe with swg user token url param if in storage', () => {
      analyticsService.setReadyForLogging();
      storageMock
        .expects('get')
        .withExactArgs(Constants.USER_TOKEN)
        .returns(Promise.resolve('swgUserToken'))
        .once();
      analyticsService.start();
      expectOpenIframe = true;
      return activityIframePort.whenReady();
    });

    it('should not call openIframe until ready for logging', () => {
      analyticsService.handleClientEvent_(event);
      expect(iframeCallback).to.be.null;
      analyticsService.setReadyForLogging();
      expectOpenIframe = true;
      return activityIframePort.whenReady();
    });

    it('should send message on port and openIframe called only once', async () => {
      analyticsService.setReadyForLogging();

      // This ensures nothing gets sent to the server.
      sandbox.stub(activityIframePort, 'execute').callsFake(() => {});

      // This triggers an event.
      eventManagerCallback({
        eventType: AnalyticsEvent.UNKNOWN,
        eventOriginator: EventOriginator.UNKNOWN_CLIENT,
        isFromUserAction: null,
        additionalParameters: null,
      });

      // These wait for analytics server to be ready to send data.
      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;
      await activityIframePort.whenReady();

      // These ensure the right event was communicated.
      expectOpenIframe = true;
      const call1 = activityIframePort.execute.getCall(0);
      const /* {?AnalyticsRequest} */ request1 = call1.args[0];
      expect(request1.getEvent()).to.equal(AnalyticsEvent.UNKNOWN);
      expect(request1.getMeta().getEventOriginator()).to.equal(
        EventOriginator.UNKNOWN_CLIENT
      );
      expect(request1.getMeta().getIsFromUserAction()).to.be.false;

      // This sends another event and waits for it to be sent
      eventManagerCallback({
        eventType: AnalyticsEvent.IMPRESSION_PAYWALL,
        eventOriginator: EventOriginator.SWG_CLIENT,
        isFromUserAction: true,
        additionalParameters: {droppedData: true},
      });
      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;

      // This ensures communications were successful
      const call2 = activityIframePort.execute.getCall(1);
      const /* {?AnalyticsRequest} */ request2 = call2.args[0];
      expect(request2).to.not.be.null;
      const meta = request2.getMeta();
      expect(request2.getEvent()).to.equal(AnalyticsEvent.IMPRESSION_PAYWALL);
      expect(meta.getEventOriginator()).to.equal(EventOriginator.SWG_CLIENT);
      expect(meta.getIsFromUserAction()).to.be.true;

      // It should have a working logging promise
      const p = analyticsService.getLoggingPromise();

      // It should be waiting for 2 logging responses
      expect(p).to.not.deep.equal(Promise.resolve());
      const loggingResponse = new FinishedLoggingResponse();
      loggingResponse.setComplete(true);
      // Simulate 1 logging response
      iframeCallback(loggingResponse);

      // It should still be waiting for 1
      expect(analyticsService.getLoggingPromise()).to.not.deep.equal(
        Promise.resolve()
      );
      iframeCallback(loggingResponse);

      // Ensure it is done waiting
      await p;
      await analyticsService.getLoggingPromise();
      expect(loggedErrors.length).to.equal(0);
    });

    describe('SwG Clearcut Service Experiment', () => {
      beforeEach(() => {
        analyticsService.setReadyForLogging();

        // This ensures nothing gets sent to the server.
        sandbox.stub(activityIframePort, 'execute').callsFake(() => {});
      });

      it('should not log to clearcut if experiment off', async () => {
        // This triggers an event.
        eventManagerCallback({
          eventType: AnalyticsEvent.UNKNOWN,
          eventOriginator: EventOriginator.UNKNOWN_CLIENT,
          isFromUserAction: null,
          additionalParameters: null,
        });

        // These wait for analytics server to be ready to send data.
        expect(analyticsService.lastAction_).to.not.be.null;
        await analyticsService.lastAction_;
        await activityIframePort.whenReady();

        expectOpenIframe = true;
        expect(eventsLoggedToService.length).to.equal(0);
      });

      it('should log to clearcut if experiment on', async () => {
        setExperimentsStringForTesting(ExperimentFlags.LOGGING_BEACON);

        // This triggers an event.
        eventManagerCallback({
          eventType: AnalyticsEvent.UNKNOWN,
          eventOriginator: EventOriginator.UNKNOWN_CLIENT,
          isFromUserAction: null,
          additionalParameters: null,
        });

        // These wait for analytics server to be ready to send data.
        expect(analyticsService.lastAction_).to.not.be.null;
        await analyticsService.lastAction_;
        await activityIframePort.whenReady();

        expectOpenIframe = true;
        expect(eventsLoggedToService.length).to.equal(1);
      });
    });
  });

  describe('Promise to log', () => {
    let iframeCallback;

    beforeEach(() => {
      // This ensure nothing gets sent to the server.
      sandbox.stub(activityIframePort, 'execute').callsFake(() => {});
      analyticsService.setReadyForLogging();

      iframeCallback = null;
      sandbox
        .stub(activityIframePort, 'on')
        .callsFake((constructor, callback) => {
          if (constructor === FinishedLoggingResponse) {
            iframeCallback = callback;
          }
        });
    });

    it('should not wait forever when port is broken', async function () {
      pretendPortWorks = false;
      // This sends another event and waits for it to be sent
      eventManagerCallback({
        eventType: AnalyticsEvent.IMPRESSION_PAYWALL,
        eventOriginator: EventOriginator.SWG_CLIENT,
        isFromUserAction: true,
        additionalParameters: null,
      });
      await analyticsService.getLoggingPromise();
      expect(loggedErrors.length).to.equal(1);
      expect(analyticsService.loggingBroken_).to.be.true;
    });

    it('should not wait forever when things seem functional', async function () {
      // This sends another event and waits for it to be sent
      eventManagerCallback({
        eventType: AnalyticsEvent.IMPRESSION_PAYWALL,
        eventOriginator: EventOriginator.SWG_CLIENT,
        isFromUserAction: true,
        additionalParameters: null,
      });
      // Tests will not automatically inform analytics service when they are
      // done logging the way a real setup would (no inner iframe for tests).
      // So waiting should trigger a timeout error and resolve the promise.
      await analyticsService.getLoggingPromise();
      expect(loggedErrors.length).to.equal(1);
    });

    it('should report error with log', async function () {
      const err = 'Fake error';
      eventManagerCallback({
        eventType: AnalyticsEvent.IMPRESSION_PAYWALL,
        eventOriginator: EventOriginator.SWG_CLIENT,
        isFromUserAction: true,
        additionalParameters: null,
      });
      const loggingResponse = new FinishedLoggingResponse();
      loggingResponse.setComplete(false);
      loggingResponse.setError(err);
      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;
      await activityIframePort.whenReady();
      const p = analyticsService.getLoggingPromise();
      iframeCallback(loggingResponse);
      await p;
      expect(loggedErrors.length).to.equal(1);
      expect(loggedErrors[0]).to.equal('Error when logging: ' + err);
    });

    it('Should work without waiting for the promise', async () => {
      // This sends another event and waits for it to be sent
      eventManagerCallback({
        eventType: AnalyticsEvent.IMPRESSION_PAYWALL,
        eventOriginator: EventOriginator.SWG_CLIENT,
        isFromUserAction: true,
        additionalParameters: {droppedData: true},
      });
      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;
      const loggingResponse = new FinishedLoggingResponse();
      loggingResponse.setComplete(true);
      // Simulate 1 logging response that occurs before anyone calls
      // getLoggingPromise
      iframeCallback(loggingResponse);
      expect(analyticsService.unfinishedLogs_).to.equal(0);
      return analyticsService.getLoggingPromise().then((val) => {
        expect(val).to.be.true;
      });
    });
  });

  it('should not log the subscription state change event', () => {
    analyticsService.lastAction_ = null;
    event.eventType = AnalyticsEvent.EVENT_SUBSCRIPTION_STATE;
    eventManagerCallback(event);
    expect(analyticsService.lastAction_).to.be.null;
    event.eventType = defEventType;
  });

  describe('Context, experiments & labels', () => {
    beforeEach(() => {
      analyticsService.setReadyForLogging();
    });

    it('should create correct context for logging', async () => {
      sandbox.stub(activityIframePort, 'execute').callsFake(() => {});
      analyticsService.setReadyToPay(true);
      analyticsService.setSku('basic');
      analyticsService.addLabels(['label']);
      eventManagerCallback(event);

      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;
      await activityIframePort.whenReady();
      expect(activityIframePort.execute).to.be.calledOnce;
      const /* {?AnalyticsRequest} */ request =
          activityIframePort.execute.getCall(0).args[0];
      expect(request).to.not.be.null;
      expect(request.getEvent()).to.deep.equal(defEventType);
      const context = request.getContext();
      expect(context).to.not.be.null;
      expect(context.getUtmMedium()).to.equal('email');
      expect(context.getUtmSource()).to.equal('scenic');
      expect(context.getUtmCampaign()).to.equal('campaign');
      expect(context.getSku()).to.equal('basic');
      expect(context.getUrl()).to.equal(URL);
      expect(context.getReadyToPay()).to.be.true;
      expect(context.getTransactionId()).to.match(
        /^.{8}-.{4}-.{4}-.{4}-.{12}$/g
      );
      expect(context.getReferringOrigin()).to.equal(
        'https://scenic-2017.appspot.com'
      );
      expect(analyticsService.getSku()).to.equal('basic');
      const labels = context.getLabelList();
      expect(labels.length).to.equal(1);
      expect(labels[0]).to.equal('label');
    });

    it('should set client timestamp in context', async () => {
      sandbox.stub(activityIframePort, 'execute').callsFake(() => {});
      const mockClientTimeSource = sandbox.spy(() => {
        return toTimestamp(12345);
      });
      analyticsService.getTimestamp_ = mockClientTimeSource;

      eventManagerCallback(event);

      await analyticsService.lastAction_;
      await activityIframePort.whenReady();
      expect(activityIframePort.execute).to.be.calledOnce;
      const /* {?AnalyticsRequest} */ request =
          activityIframePort.execute.getCall(0).args[0];
      expect(request).to.not.be.null;
      expect(mockClientTimeSource).to.be.calledOnce;
      expect(request.getContext().getClientTimestamp()).to.deep.equal(
        mockClientTimeSource()
      );
    });

    it('should set context for empty experiments', async () => {
      setExperimentsStringForTesting('');
      sandbox.stub(activityIframePort, 'execute').callsFake(() => {});
      eventManagerCallback(event);
      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;
      await activityIframePort.whenReady();
      expect(activityIframePort.execute).to.be.calledOnce;
      const /* {?AnalyticsRequest} */ request =
          activityIframePort.execute.getCall(0).args[0];
      expect(request).to.not.be.null;
      expect(request.getContext().getLabelList()).to.deep.equal([]);
    });

    it('should set context for non-empty experiments', async () => {
      setExperimentsStringForTesting('experiment-A,experiment-B');
      sandbox.stub(activityIframePort, 'execute').callsFake(() => {});
      await activityIframePort.whenReady();
      eventManagerCallback(event);
      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;
      expect(activityIframePort.execute).to.be.calledOnce;
      const /* {?AnalyticsRequest} */ request =
          activityIframePort.execute.getCall(0).args[0];
      expect(request).to.not.be.null;
      expect(request.getContext().getLabelList()).to.deep.equal([
        'experiment-A',
        'experiment-B',
      ]);
    });

    it('should add additional labels to experiments', async () => {
      analyticsService.addLabels(['L1', 'L2']);
      setExperimentsStringForTesting('E1,E2');
      sandbox.stub(activityIframePort, 'execute').callsFake(() => {});
      eventManagerCallback(event);
      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;
      await activityIframePort.whenReady();
      const /** {?AnalyticsRequest} */ request1 =
          activityIframePort.execute.getCall(0).args[0];
      expect(request1.getContext().getLabelList()).to.deep.equal([
        'L1',
        'L2',
        'E1',
        'E2',
      ]);

      analyticsService.addLabels(['L3', 'L4']);
      eventManagerCallback(event);
      expect(analyticsService.lastAction_).to.not.be.null;
      await analyticsService.lastAction_;
      const /** {?AnalyticsRequest} */ request2 =
          activityIframePort.execute.getCall(1).args[0];
      expect(request2.getContext().getLabelList()).to.deep.equal([
        'L1',
        'L2',
        'E1',
        'E2',
        'L3',
        'L4',
      ]);
    });

    it('should dedupe duplicate labels', () => {
      analyticsService.addLabels(['L1', 'L2', 'L1', 'L2']);
      expect(analyticsService.context_.getLabelList()).to.deep.equal([
        'L1',
        'L2',
      ]);
      analyticsService.addLabels(['L1', 'L2', 'L3']);
      expect(analyticsService.context_.getLabelList()).to.deep.equal([
        'L1',
        'L2',
        'L3',
      ]);
    });

    it('should respect custom URL set by AMP', async () => {
      sandbox.stub(activityIframePort, 'execute').callsFake(() => {});
      analyticsService.setUrl('diffUrl');
      eventManagerCallback(event);
      await analyticsService.lastAction_;
      await activityIframePort.whenReady();
      expect(activityIframePort.execute).to.be.calledOnce;
      const /* {?AnalyticsRequest} */ request =
          activityIframePort.execute.getCall(0).args[0];
      expect(request.getContext().getUrl()).to.equal('diffUrl');
    });
  });

  describe('Publisher Events', () => {
    beforeEach(() => {
      analyticsService.setReadyForLogging();
    });

    /**
     * Ensure that analytics service is only logging events from the passed
     * originator if shouldLog is true.
     * @param {!EventOriginator} originator
     * @param {boolean} shouldLog
     * @param {AnalyticsEvent=} eventType
     */
    const testOriginator = function (originator, shouldLog, eventType) {
      const prevOriginator = event.eventOriginator;
      const prevType = event.eventType;
      analyticsService.lastAction_ = null;
      event.eventOriginator = originator;
      if (eventType) {
        event.eventType = eventType;
      }
      eventManagerCallback(event);
      const didLog = analyticsService.lastAction_ !== null;
      expect(shouldLog).to.equal(didLog);
      event.eventOriginator = prevOriginator;
      if (eventType) {
        event.eventType = prevType;
      }
    };

    it('should never log showcase events', () => {
      testOriginator(EventOriginator.SHOWCASE_CLIENT, false);
    });

    it('should not log publisher events by default', () => {
      testOriginator(EventOriginator.SWG_CLIENT, true);
      testOriginator(EventOriginator.SWG_SERVER, true);
      testOriginator(EventOriginator.AMP_CLIENT, false);
      testOriginator(EventOriginator.PROPENSITY_CLIENT, false);
      testOriginator(EventOriginator.PUBLISHER_CLIENT, false);
    });

    it('should log publisher events if configured', () => {
      runtime.configure({enableSwgAnalytics: true});
      testOriginator(EventOriginator.SWG_CLIENT, true);
      testOriginator(EventOriginator.AMP_CLIENT, true);
      testOriginator(EventOriginator.PROPENSITY_CLIENT, true);
      testOriginator(EventOriginator.PUBLISHER_CLIENT, true);

      // Should still not log showcase events
      testOriginator(EventOriginator.SHOWCASE_CLIENT, false);
    });

    it('should always log page load event in AMP', () => {
      testOriginator(
        EventOriginator.AMP_CLIENT,
        true,
        AnalyticsEvent.IMPRESSION_PAGE_LOAD
      );
    });
  });

  describe('EventParams', () => {
    it('should ignore additionalParameters', () => {
      const logRequest = analyticsService.createLogRequest_(event);
      expect(logRequest.setParams()).to.be.undefined;
    });

    it('should process EventParams', () => {
      event.additionalParameters = new EventParams();
      const logRequest = analyticsService.createLogRequest_(event);
      expect(logRequest.getParams()).to.be.instanceOf(EventParams);
      event.additionalParameters = {};
    });
  });
});
