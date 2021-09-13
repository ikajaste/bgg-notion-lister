fs = require('fs');
const { Client } = require("@notionhq/client");
const { makeConsoleLogger } = require('@notionhq/client/build/src/logging');
const { exit } = require('process');
const { start } = require('repl');

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

async function bgg_searchGame(queryText, exact=false) {
  // Apparently BGG api can't handle ":" even if encoded as "%3A"
  const qs = queryText.replace(":", " ");
  let res = await bgg('search', {'query': qs, 'exact': 1, 'type': 'boardgame,boardgameexpansion,boardgameaccessory'});
  if (exact) return res;
  if (res.items && res.items.total && res.items.total > 0) return res;

  res = await bgg('search', {'query': qs, 'exact': 0, 'type': 'boardgame,boardgameexpansion,boardgameaccessory'});

  // Remove weird duplicate results
  if (Array.isArray(res.items.item)) {
    final = [];
    ids = [];
    for (const entry of res.items.item) {
      if (ids.includes(entry.id)) continue;
      final.push(entry);
      ids.push(entry.id);
    }
    res.total = final.length;
    if (final.length == 1) {
      res.items.item = final.pop();
    } else {
      res.items.item = final;
    }
  }

  return res;
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
  item.constructed_bgg_url = 'https://www.boardgamegeek.com/boardgame/'+item.id;
  if (item.image) {
    item.image = item.image.replace('&amp;&amp;#35;40;','(').replace('&amp;&amp;#35;41;',')');
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
    "constructed_bgg_url": "https://...",
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
  const nitems = [];
  for (const item of res.items.item) {
    nitems.push(bgg_processItem(item));
  }
  return nitems;
}

async function bgg_gameDetails(gameId) {
  const res = await bgg('thing', {'id': gameId});
  return bgg_processItem(res.items.item);
}


function groupString(items, max=1, placeholder="") {
  if (!items || !Array.isArray(items)) return placeholder;
  const c = items;
  let str = items.slice(0, max).join(", ");
  if (c > max) str = str+' + '+(publisherCount-3)+" more";
  return str;
}

function bgg_detailString(det) {
  const publisherString = groupString(det.details.boardgamepublisher, 3, "?");
  const designerString = groupString(det.details.boardgamedesigner, 3, "?");
  return "["+det.id+": "+det.primaryName+" ("+det.yearpublished+") "+det.minplayers+"-"+det.maxplayers+"ply "+det.playingtime+"min by "+designerString+" from "+publisherString+"]";
}

function dumpj(data) {
  console.log(JSON.stringify(data,null,2));
}

function notion_item_debug(notionData) {
  return notionData.properties["DEBUG_THIS"] && notionData.properties["DEBUG_THIS"].checkbox && notionData.properties["DEBUG_THIS"].checkbox == true;
}

class NotionItem {
  get data() {
    return this.itemData;
  }

  constructor(itemData) {
    this.itemData = itemData;
  }

  setContainer(container) {
    this.container = container;
  }

  doDebug() {
    if (this.debug) {
      console.log("___ DEBUG FOR:", this.name, this.bgg_id, this.id)
      //dumpj(queueItem.notion_data);
      dumpj(this.data.properties["Display name"]);
      //dumpj(this.data.properties["Expansion for"]);
      dumpj(this.data.properties["Expanded by"]);
      dumpj(this.data.properties["Minor expansion list"]);
      //dumpj(this.data.properties["Root game name"]);
    }
  }

  hasName() {
    const gameTitleObject = this.itemData.properties["Name"].title;
    if (gameTitleObject.length === 0) return false;
    const name = this.name;
    if (name == '' || name == 'undefined') return false;
    return true;
  }
  get lautapeliopas_url() {
    const propertyData = this.itemData.properties["Lautapeliopas"];
    if (!propertyData) return false;
    return propertyData.url;
  }
  get debug() {
    return notion_item_debug(this.itemData);
  }
  get category() {
    const propertyData = this.itemData.properties["Game category"];
    if (!propertyData) return "default";
    return propertyData.select.name;
  }
  get alternateNames() {
    const propertyData = this.itemData.properties["Alternate names"];
    if (!propertyData) return null;
    return propertyData.rich_text.map(i => i.plain_text).join("");
  }
  get displayName() {
    const propertyData = this.itemData.properties["Display name"];
    if (!propertyData) return null;
    return propertyData.formula.string;
  }
  get name() {
    const gameTitleObject = this.itemData.properties["Name"].title;
    if (gameTitleObject.length > 0) {
      return gameTitleObject[0].plain_text;
    } else {
      return "";
    }
  }
  isExpansion() {
    const propertyData = this.itemData.properties["Expansion for"];
    if (propertyData.relation.length > 0) return true;
    return false;
  }
  isMinorExpansion() {
    const propertyData = this.itemData.properties["Is minor expansion"];
    return propertyData.checkbox;
  }
  hasExpansions() {
    const propertyData = this.itemData.properties["Expanded by"];
    if (propertyData.relation.length > 0) return true;
    return false;
  }
  get expansions() {
    const propertyData = this.itemData.properties["Expanded by"];
    if (propertyData.relation.length == 0) return [];
    const items = propertyData.relation.map(i => this.container.getItem(i.id));
    return items;
  }
  get rootItem() {
    const propertyData = this.itemData.properties["Expansion for"];
    if (propertyData.relation.length == 0) return null;
    const rootGameId = propertyData.relation[0].id;
    console.log("root game id:", rootGameId);
    const ri = this.container.getItem(rootGameId);
    console.log("root game:", ri);
    return ri;
  }
  get minorExpansionList() {
    const propertyData = this.itemData.properties["Minor expansion list"];
    //if (propertyData.rollup.array.length == 0) return null;
    return propertyData.rollup.array.map(i => i.formula['string']).filter(i => i !== "");
  }
  get expansionRootName() {
    const propertyData = this.itemData.properties["Root game name"];
    if (propertyData.rollup.array.length == 0) return null;
    return propertyData.rollup.array[0].title[0].plain_text;
    //return this.rootItem ? this.rootItem.name : null;
  }
  get queryTitle() {
    if (this.isExpansion()) {
      const rootname = this.expansionRootName;
      return rootname ? rootname+": "+this.name : this.name;
    } else {
      return this.name;
    }
  }
  get bgg_id() {
    const propertyData = this.itemData.properties["bgg_id"];
    if (!propertyData) return null;
    return propertyData.number;
  }
  get id() {
    return this.itemData.id;
  }
}

class NotionContainer {
  items = [];

  include(item) {
    const itemId = item.id;
    item.container = this;
    if (!this.hasItem(item.id)) {
      this.items.push(item);
    }
    item.doDebug();
  }
  getItem(id) {
    for (const item of this.items) {
      if (item.id == id) return item;
    }
  }
  hasItem(id) {
    for (const item of this.items) {
      if (item.id == id) return True;
    }
    return false;
  }
  sort(sortFunction) {
    this.items.sort(sortFunction);
    //noop
  }

  doDebug() {
    for (const item of this.items) {
      item.doDebug();
    }
  }
}

const notionItems = new NotionContainer();

async function doThings() {
  currentTime = new Date();
  if (verbose) { console.log("Accessing notion database "+database_id+"..."); }
  const notionResult = await notion.databases.query({
    database_id: database_id
  });
  if (verbose) { console.log("Notion database access complete."); }
  
  // Collect items, and check for missing BGG links
  detailsQueue = [];
  if (notionResult.object == 'list') {
    if (verbose) console.log("Count of items:", notionResult.results.length);
    for (const gameItem of notionResult.results) {
      game = new NotionItem(gameItem);
      notionItems.include(game);

      const gameTitleObject = gameItem.properties["Name"].title;
      if (game.hasName()) {
        const gameTitle = game.name;
        if (verbose) console.log("*** Processing game:", gameTitle);
        if (gameItem.properties.bgg_id && gameItem.properties.bgg_id.number) {
          const bggId = gameItem.properties.bgg_id.number;
          if (verbose) console.log("Game "+gameTitle+" already has bgg_id:", bggId);
          detailsQueue.push({ gameTitle: gameTitle, bgg_id: bggId, notion_id: gameItem.id, notion_data: gameItem });
          continue;
        }
        if (!gameItem.properties.bgg_id || !gameItem.properties.bgg_id.number) {
          if (gameItem.properties.bgg_potential_matches && gameItem.properties.bgg_potential_matches.rich_text.length > 0) {
            if (verbose) console.log("Already has potential matches, skipping");
            continue;
          }
          queryString = game.queryTitle;
          if (verbose) console.log("Performing a BGG search for: "+queryString);
          let bggResult = await bgg_searchGame(queryString);
          if (Array.isArray(bggResult.items.item)) {
            if (verbose) console.log("Found "+bggResult.items.total+" potential matches");
            const potentialIds = bggResult.items.item.map(item => item.id);
            const bggDetails = await bgg_multiGameDetails(potentialIds);
            const potentialStrings = bggDetails.map(det => bgg_detailString(det));
            let finalPotentialString = potentialStrings.join("\n");
            if (finalPotentialString.length > 2000) finalPotentialString = finalPotentialString.slice(0,1997) + "...";
            if (verbose) console.log("Updating potential matches to Notion...");
            await notion.pages.update({
              page_id: gameItem.id,
              properties: {
                bgg_potential_matches: { rich_text: [ { type: "text", text: { content: finalPotentialString } } ] },
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
    sync = async (notionKey, bggKey, notionType) => {
      const props = queueItem.notion_data.properties[notionKey];
      if (props) { // if empty, will not exist
        if (props.number && props.number !== 0) return; // Is already set
        if (props.url && props.url !== "") return; // Is already set
        if (props.rich_text && props.rich_text.length > 0) return; // Is already set
      }
      if (!bggData) {
        if (verbose) console.log("Missing data for at least "+notionKey+" - fetching from BGG")
        bggData = await bgg_gameDetails(queueItem.bgg_id); // Fetch data
      }
      if (!bggData[bggKey] && bggData[bggKey] !== 0) return;
      const newContent = bggData[bggKey];
      if (notionType === "number") {
        toUpdate[notionKey] = { number: newContent }
      } else if (notionType === "url") {
        toUpdate[notionKey] = { url: newContent }
      } else if (notionType === "rich_text") {
        toUpdate[notionKey] = { rich_text: [ { type: "text", text: { content: newContent } } ] };
      } else {
        console.log(" BGG KEY "+bggKey+" FAILS"); dumpj(bggData);
      }
    }

    if (notion_item_debug(queueItem.notion_data)) {
      //dumpj(queueItem.notion_data);
      //dumpj(queueItem.notion_data.properties["Display name"]);
      //dumpj(queueItem.notion_data.properties["Expansion for"]);
      //game = notionItems.getItem(queueItem.notion_id)
    }
    if (queueItem.notion_data.data_complete && queueItem.notion_data.data_complete.checkbox == true) continue; // data marked as complete, skipping
    await sync("Players min", "minplayers", "number");
    await sync("Players max", "maxplayers", "number");
    await sync("Playtime min", "minplaytime", "number");
    await sync("Playtime max", "maxplaytime", "number");
    await sync("Age", "minage", "number");
    await sync("Published year", "yearpublished", "number");
    await sync("bgg_name", "primaryName", "rich_text");
    await sync("BGG", "constructed_bgg_url", "url");
    await sync("bgg_image_url", "image", "url");

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
  notionItems.doDebug();
}

function exportTitle(item) {
  let add = item.displayName;
  if (item.lautapeliopas_url) {
    add = '<a href="'+item.lautapeliopas_url+'">'+add+'</a>';
  }
  if (item.minorExpansionList.length > 0) {
    // Note: since minorExpansionList is calculated from rollup of a formula resultin in string
    // it is not possible to get a backreference.
    // To do a backreference with links, one could instead use something like:
    //   item.expansions.filter(i => i.isMinorExpansion).map(i => i.lautapeliopas_url ? "a href..." : i.displayName)
    add += " ("+item.minorExpansionList.map(str => '+ '+str).join(" ")+")";
  }
  return add;
}

function doExport() {
  notionItems.sort((a,b) => a.name.toUpperCase() < b.name.toUpperCase() ? -1 : +1);
  let out = "";
  const outCat = {};
  const knownCategories = ["default", "Party game", "Children's game"];
  for (const item of notionItems.items) {
    if (item.isExpansion()) continue;
    let add = exportTitle(item) + "<br />\n";

    const cat = knownCategories.includes(item.category) ? item.category : "default";
    if (!outCat[cat]) outCat[cat] = [];
    startLetter = item.name.slice(0,1);
    if (item.hasExpansions()) {
      const exps = item.expansions.filter(i=>!i.isMinorExpansion()).sort((a,b) => a.name.toUpperCase() < b.name.toUpperCase() ? -1 : +1);
      for (const exp of exps) {
        add = add + '&nbsp;&nbsp;&nbsp;&nbsp;lisäosa: '+ exportTitle(exp) + "<br />\n";
      }
    }
    outCat[cat].push({ add: add, name: item.name, id: item.id, startLetter: startLetter });

  }

  for (const category of knownCategories) {
    let prevStartLetter = "";
    out += "\n\n<!-- Category: "+category+" -->\n<p>\n\n"
    if (!outCat[category]) continue;
    for (const item of outCat[category]) {
      if (category === 'default' && prevStartLetter != item.startLetter) {
        out += "\n<!-- "+item.startLetter+" -->\n\n<br/>\n";
        prevStartLetter = item.startLetter;
      }
      out += item.add;
    }
    out += "\n\n</p>\n\n"
  }

  try {
    let content = fs.readFileSync('export-src/pre');
    out = content + out;
  } catch (err) {
    console.log("No export-src/pre found - ignoring");
  }
  try {
    let content = fs.readFileSync('export-src/post');
    out = out + content;
  } catch (err) {
    console.log("No export-src/post found - ignoring");
  }
  try {
    fs.writeFileSync("export/index.html", out);
  } catch (err) {
    console.warn("Failed to write to export/index.html");
  }
}

doThings().then(() => {
  console.log("Main fetch and update done.");
  console.log("Proceed to export.");
  doExport();
  console.log("Export done.");
});
console.log("Main loop exit.");


/*

var bgg = require('bgg')(options);

bgg('search', {'query': 'Terraforming Mars', 'exact': 1})
  .then(function(results){
    console.log(results);
    console.log(JSON.stringify(results,null,2));
  });


*/