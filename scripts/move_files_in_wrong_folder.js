
const {google} = require('googleapis');

let helper = require('../js/google');

let target_user = process.argv[2];


const DO_MODIFICATION = process.env.WRITE === 'true';

let list_parent_folders = async function(parent='root',pageToken) {
  const service = google.drive('v3');
  return service.files.list({
    q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = 'Author'`,
    fields: 'nextPageToken, files(id, name)',
    spaces: 'drive',
    pageToken: pageToken
  }).then( resp => {
    let result = resp.data;
    if (result.nextPageToken) {
      return list_parent_folders(parent,result.nextPageToken).then( dat => result.files.concat( dat ) );
    }
    return result.files;
  });
};

let remove_folder = async function(folderid) {
  const service = google.drive('v3');
  var request = service.files.delete({
    'fileId': folderid
  });
  return request;
}

let list_pdfs = async function(parent='root',pageToken) {
  const service = google.drive('v3');
  return service.files.list({
    q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'nextPageToken, files(id, name)',
    spaces: 'drive',
    pageToken: pageToken
  }).then( resp => {
    let result = resp.data;
    if (result.nextPageToken) {
      return list_pdfs(parent,result.nextPageToken).then( dat => result.files.concat( dat ) );
    }
    return result.files;
  });
};

helper.getServiceAuth().then( async () => {

  let ROOT = '0By48KKDu9leCVXU3dXRSeFBYTE0';
  //let sysfolders = await helper.get_system_folders(ROOT);

  //console.log(sysfolders);

  let all_author_folders = await list_parent_folders();

  while (all_author_folders.length > 0) {
    let a_folder = all_author_folders.shift();
    let child_pdfs = await list_pdfs(a_folder.id);
    if (child_pdfs.length > 0 && child_pdfs.length < 2 && child_pdfs[0].name.length == 2) {
      await remove_folder(a_folder.id);
      continue;
    } else if (child_pdfs.length > 1) {
      console.log(child_pdfs);
      break;
    }
    if (child_pdfs.length == 0) {
      await remove_folder(a_folder.id);
    }
    console.log(all_author_folders.length);
  //   await remove_folder(a_folder.id);
  }

}).catch(err => {
  console.error(err);
});