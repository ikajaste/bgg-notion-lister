fs = require('fs');
const { Client } = require("@notionhq/client");
const { makeConsoleLogger } = require('@notionhq/client/build/src/logging');

const verbose = true;

// all options are optional
const bgg_options = {
  timeout: 10000, // timeout of 10s (5s is the default)

  // see https://github.com/cujojs/rest/blob/master/docs/interceptors.md#module-rest/interceptor/retry
  retry: {
    initial: 100,
    multiplier: 2,
    max: 15e3
  }
}
const bgg = require('bgg')(bgg_options);

const secret_token = process.env.NOTION_TOKEN ? process.env.NOTION_TOKEN : fs.readFileSync('.config/notion_token');
const database_id = process.env.DATABASE_ID ? process.env.DATABASE_ID : fs.readFileSync('.config/database_id');

// Initializing a client
const notion = new Client({
  auth: secret_token,
});

async function bgg_searchGame(queryText) {
  return await bgg('search', {'query': queryText, 'exact': 1, 'type': 'boardgame,boardgameexpansion,boardgameaccessory'});
}

// Convert and append bgg data into a more friendly-to-use internal format
function bgg_processItem(item) {
  if (Array.isArray(item.name)) {
    item.primaryName = item.name.filter(n => n.type === "primary").map(n=>n.value).join(" / ");
  } else {
    item.primaryName = item.name.value;
  }
  const flatten_properties = ["yearpublished", "minplayers", "maxplayers", "playingtime", "minplaytime","maxplaytime","minage"];
  for (const prop of flatten_properties) {
    if (item[prop] && item[prop].value !== undefined) {
      item[prop] = item[prop].value;
    }
  }
  item.details = {};
  for (const linkItem of item.link) {
    if (!item.details[linkItem.type]) item.details[linkItem.type] = [];
    item.details[linkItem.type].push(linkItem.value);
  }
  return item;
  /* Returning object:
   {
    "type": "boardgame",
    "id": 205398,
    "thumbnail": "https://...",
    "image": "https://...",
    "name": [ { "type": "primary", "sortindex": 1, "value": "Citadels" }, { "type": "alternate", "sortindex": 1, "value": "Citadela DeLuxe" } ],
    "description": "In Citadels, players...",
    "yearpublished": 2016,
    "minplayers": 2,
    "maxplayers": 8,
    "poll": [...],
    "playingtime": 60,
    "minplaytime": 30,
    "maxplaytime": 60,
    "minage": 10,
    "link": [...],
    "primaryName": "Citadels",
    "details": {
      "boardgamecategory": [...],
      "boardgamemechanic": [...],
      "boardgamefamily": [...],
      "boardgameimplementation": [...],
      "boardgamedesigner": [...],
      "boardgameartist": [...],
      "boardgamepublisher": [...],
    }
  } */
}

async function bgg_multiGameDetails(gameIds) {
  res = await bgg('thing', {'id': gameIds.join(","), "versions": 0, "videos": 0, "stats": 0, "comments": 0, "ratingcomments": 0});
  nitems = [];
  for (const item of res.items.item) {
    nitems.push(bgg_processItem(item));
  }
  return nitems;
}

async function bgg_gameDetails(gameId) {
  const res = await bgg('thing', {'id': gameId});
  return bgg_processItem(res.items.item);
}


function groupString(items, max=1) {
  const c = items;
  let str = items.slice(0, max).join(", ");
  if (c > max) str = str+' + '+(publisherCount-3)+" more";
  return str;
}

function bgg_detailString(det) {
  const publisherString = groupString(det.details.boardgamepublisher, 3);
  const designerString = groupString(det.details.boardgamedesigner, 3);
  return "["+det.id+": "+det.primaryName+" ("+det.yearpublished+") "+det.minplayers+"-"+det.maxplayers+"ply "+det.playingtime+"min by "+designerString+" from "+publisherString+"]";
}

function dumpj(data) {
  console.log(JSON.stringify(data,null,2));
}

async function doThings() {
  currentTime = new Date();
  if (verbose) { console.log("Accessing notion database "+database_id+"..."); }
  const notionResult = await notion.databases.query({
    database_id: database_id
  });
  if (verbose) { console.log("Database access complete."); }
  
  // Collect items, and check for missing BGG links
  detailsQueue = [];
  if (notionResult.object == 'list') {
    if (verbose) console.log("Count of items:", notionResult.results.length);
    for (const gameItem of notionResult.results) {
      const gameTitleObject = gameItem.properties["Name"].title;
      if (gameTitleObject.length > 0) {
        const gameTitle = gameTitleObject[0].plain_text;
        if (gameTitle == '' || gameTitle == 'undefined') continue; // Skip unnamed game
        if (verbose) console.log("*** Processing game:", gameTitle);
        if (gameItem.properties.bgg_id && gameItem.properties.bgg_id.number) {
          const bggId = gameItem.properties.bgg_id.number;
          if (verbose) console.log("Game "+gameTitle+" already has bgg_id:", bggId);
          detailsQueue.push({ bgg_id: bggId, notion_id: gameItem.id, notion_data: gameItem });
          continue;
        }
        if (!gameItem.properties.bgg_id || !gameItem.properties.bgg_id.number) {
          if (gameItem.properties.bgg_potential_matches && gameItem.properties.bgg_potential_matches.rich_text.length > 0) {
            if (verbose) console.log("Already has potential matches, skipping");
            continue;
          }
          if (verbose) console.log("Performing a BGG search for: "+gameTitle);
          const bggResult = await bgg_searchGame(gameTitle);
          //dumpj(bggResult);
          if (Array.isArray(bggResult.items.item)) {
            if (verbose) console.log("Found "+bggResult.items.total+" potential matches");
            const potentialIds = bggResult.items.item.map(item => item.id);
            const bggDetails = await bgg_multiGameDetails(potentialIds);
            const potentialStrings = bggDetails.map(det => bgg_detailString(det));
            if (verbose) console.log("Updating potential matches to Notion...");
            await notion.pages.update({
              page_id: gameItem.id,
              properties: {
                bgg_potential_matches: { rich_text: [ { type: "text", text: { content: potentialStrings.join("\n") } } ] },
                //api_sync_notes:  { rich_text: [ { type: "text", text: { content: "Synced. "+Math.floor(Math.random()*1000) } } ] },
                api_latest_sync: { date: { start: currentTime.toISOString() } }
              }
            });
            
            //console.log(bggResult);
            //console.log(JSON.stringify(bggResult,null,2));
          } else if (bggResult.items.total === 0) {
            console.log("No matches found for "+gameTitle);
          } else { // Single match
            const composedName = bggResult.items.item.name.value + " ("+bggResult.items.item.yearpublished.value+")"
            const bggId = bggResult.items.item.id;
            if (verbose) console.log("Found single match:", composedName, "with id", bggId);
            if (verbose) console.log("Updating bgg id to Notion...");
            await notion.pages.update({
              page_id: gameItem.id,
              properties: {
                bgg_id: { number: bggId },
                //api_sync_notes:  { rich_text: [ { type: "text", text: { content: "Synced. "+Math.floor(Math.random()*1000) } } ] },
                api_latest_sync: { date: { start: currentTime.toISOString() } }
              }
            });
            detailsQueue.push({ gameTitle: gameTitle, bgg_id: bggId, notion_id: gameItem.id, notion_data: gameItem });
          }
        }
      }
    }
  }
  // Check every item for details data
  console.log("Proceeding to check details.")
  for (const queueItem of detailsQueue) {
    if (verbose) console.log("*** Processing details for game",queueItem.gameTitle, "/", queueItem.bgg_id);
    if (!queueItem.notion_data) {
      // fetch from notion
      continue;
    }

    bggData = queueItem.bgg_data;
    toUpdate = {};
    sync = async (notionKey, bggKey) => {
      if (queueItem.notion_data.properties[notionKey] && queueItem.notion_data.properties[notionKey].number && queueItem.notion_data.properties[notionKey].number !== 0) return; // Is already set
      if (!bggData) {
        if (verbose) console.log("Missing data for at least "+notionKey+" - fetching from BGG")
        bggData = await bgg_gameDetails(queueItem.bgg_id); // Fetch data
      }
      if (bggData[bggKey] || bggData[bggKey] === 0) toUpdate[notionKey] = { number: bggData[bggKey] }
      else {
        console.log(" BGG KEY "+bggKey+" FAILS"); dumpj(bggData);
      }
    }

    //dumpj(queueItem.notion_data);
    if (queueItem.notion_data.data_complete && queueItem.notion_data.data_complete.checkbox == true) continue; // data marked as complete, skipping
    await sync("Players min", "minplayers");
    await sync("Players max", "maxplayers");
    await sync("Playtime min", "minplaytime");
    await sync("Playtime max", "maxplaytime");
    await sync("Age", "minage");
    await sync("Published year", "yearpublished");

    // to sync: BGG, bgg_name 

    if (Object.keys(toUpdate).length > 0) {
      if (verbose) console.log("Updating to Notion: "+Object.keys(toUpdate).join(", "));
      toUpdate["api_latest_sync"] = { date: { start: currentTime.toISOString() } };
      await notion.pages.update({
        page_id: queueItem.notion_id,
        properties: toUpdate
      });
    }
  }

}

doThings();
console.log("Exit main loop.");

/*

var bgg = require('bgg')(options);

bgg('search', {'query': 'Terraforming Mars', 'exact': 1})
  .then(function(results){
    console.log(results);
    console.log(JSON.stringify(results,null,2));
  });


*/