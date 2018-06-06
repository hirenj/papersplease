'use strict';
/*jshint esversion: 6, node:true */

let download_queue = 'https://sqs.us-east-1.amazonaws.com/978536629153/papersplease-DownloadQueue';
let bucket_name = 'papersplease-papers';

let config = {};

try {
  config = require('./resources.conf.json');
  download_queue = config.queue.DownloadQueue;
  bucket_name = config.buckets.dataBucket;
} catch (e) {
}

if (config.region) {
  require('lambda-helpers').AWS.setRegion(config.region);
}

const Queue = require('lambda-helpers').queue;
const google = require('./js/google');
const Events = require('lambda-helpers').events;

google.setRootBucket(bucket_name);

const download_changed_files = function(page_token) {
  return google.getChangedFiles(page_token);
};

const update_page_token = function(page_token) {
  const AWS = require('lambda-helpers').AWS;
  const s3 = new AWS.S3();
  var params = {
    Bucket: bucket_name,
    Key: 'config/page_token',
    Body: JSON.stringify({page_token: page_token})
  };
  console.log(params);
  return s3.putObject(params).promise();
};

const get_page_token = function() {
  const AWS = require('lambda-helpers').AWS;
  const s3 = new AWS.S3();
  var params = {
    Bucket: bucket_name,
    Key: 'config/page_token'
  };
  return s3.getObject(params).promise().then( data => {
    return JSON.parse(data.Body.toString());
  }).catch( err => {
    console.log('Did not get page token',err.message,err.statusCode);
    return { page_token: 'none' };
  });
};

exports.googleWebhook = function acceptWebhook(event,context) {
  // downloadEverything()
  // START STEP FUNCTION TO DOWNLOAD FILES
};

exports.queueDownloads = function queueDownloads(event,context) {

  let queue = new Queue(download_queue);
  var download_promise = Promise.resolve(true);

  download_promise = get_page_token()
  .then( token => download_changed_files(token.page_token) )
  .then((fileinfos) => {
    return update_page_token(fileinfos.token).then( () => fileinfos.files );
  });

  // Push all the shared files into the queue
  download_promise.then(function(files) {
    console.log("Files to download ",files);
    // We should increase the frequency the download daemon runs here
    if (files.length == 0) {
      return Promise.resolve(false);
    }
    console.log("Queueing files for download");
    return Promise.all(files.map((file) => {
      console.log('Message',{'id' : file.id, 'name' : file.name, 'md5' : file.md5Checksum });
      return queue.sendMessage({'id' : file.id, 'name' : file.name, 'md5' : file.md5Checksum });
    }));
  }).then(function() {
    context.succeed('Done');
  }).catch(function(err) {
    console.error(err,err.stack);
    context.succeed('Done');
  });
};

exports.setTags = function(event,context) {
  let filename = event.key;
  let fileId = filename.replace(/.*google\-/,'');
  let tags = (event.extracted.stamps || []).map( stamp => stamp.text );
  console.log('Setting tags for ',fileId,tags);
  google.setTagsForFileId( fileId, tags ).then( () => {
    context.succeed(event);
  }).catch( err => {
    context.fail(err.message);
  });
};

exports.downloadFiles = function downloadFiles(event,context) {
  console.log("Lambda downloadFiles execution");

  let auth_data = null;

  const have_auth = google.getServiceAuth();

  const queue = new Queue(download_queue);

  const count = 1;

  have_auth.then(() => {

    return queue.shift(count);

  }).then(function(messages) {
    if (messages.length < 1 ) {
      throw new Error('No messages');
    }
    return Promise.all(messages.map(function(message) {
      let file = JSON.parse(message.Body);
      console.log(file.id);
      return google.downloadFileIfNecessary({
        'id' : file.id,
        'auth_token' : auth_data,
        'md5' : file.md5,
        'name' : file.name,
        'groupid' : file.group
      }).then( downloaded => {
        queue.finalise(message.ReceiptHandle);
      });
    }));
  }).catch(function(err) {
    if (err.message === 'No messages') {
      console.log("No messages");
      context.succeed({messageCount: 0});
    } else {
      console.error(err);
      console.error(err.stack);
      context.fail({error: err.message});
    }
  }).then(function() {
    context.succeed({ messageCount: 1 });
  });
};

/*
  subscribeWebhook -> run again 5 minutes before expiration time for hook
  change -> set rule to run once 3 minutes from now
  downloadEverything -> set change_state (i.e. the target for downloadEverything) to current state
*/

exports.subscribeWebhook = function(event,context) {
  console.log(event);

  if ( ! event.base_url) {
    console.log("No base url, returning");
    context.succeed('Done');
    return;
  }

  return google.registerHook(event.base_url+'/hook');
};