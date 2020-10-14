
const {google} = require('googleapis');

let helper = require('../js/google');

let target_user = process.argv[2];


const DO_MODIFICATION = process.env.WRITE === 'true';

let list_pdfs = async function(parent='root',pageToken) {
  const service = google.drive('v3');
  return service.files.list({
    q: `'${parent}' in parents and mimeType = 'application/pdf'`,
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

let list_parents = async function(fileId) {
  const service = google.drive('v3');
  let parents = await service.files.get({
    fileId,
    fields: 'parents'
  }).then( resp => {
    return resp.data.parents;
  });
  return parents;
}

helper.getServiceAuth().then( async () => {

  let shared_folders = await helper.get_shared_folders();

  if (! target_user ) {
    console.log('No user specified, select from the following users:');
    console.log(Object.values(shared_folders).map( folder => folder.user ));
    return;
  }

  let wanted_folders = Object.values(shared_folders).filter( folder => {
    return folder.user == target_user;
  });

  let [wanted_folder_id] = wanted_folders.map( folder => folder.id );

  if (! wanted_folder_id ) {
    return;
  }

  console.log('Moving PDFs to single parent model for folder',wanted_folder_id);

  let all_pdfs = await list_pdfs(wanted_folder_id);

  let tags = await helper.get_existing_tags(wanted_folder_id);

  console.log(all_pdfs.length,'PDF files to process');

  while (all_pdfs.length > 0) {
    console.log(all_pdfs.length,'remaining');
    let pdf = all_pdfs.shift();
    let parents = await list_parents(pdf.id);
    let wanted_tags = parents.map( parid => {
      let matching_tags = tags.filter( tag => tag.id === parid );
      if (matching_tags.length > 0) {
        return matching_tags.map( tag => tag.name );
      }
    }).filter(tag => tag).filter( tag => (tag !== 'inbox') && (tag.indexOf('sysvol') < 0 ));
    console.log([pdf.name,wanted_tags.join(',')].join('\t'));
    if (DO_MODIFICATION) {
      await helper.set_shortcuts_for_file(pdf.id,wanted_tags,['inbox'],[wanted_folder_id]);
    }
  }

}).catch(err => {
  console.error(err);
});