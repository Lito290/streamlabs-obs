import { ServiceHelper, mutation } from '../stateful-service';
import { ScenesService } from './scenes';
import { Source, SourcesService, TSourceType } from '../sources';
import {
  ISceneItem,
  SceneItem,
  IScene,
  ISceneApi,
  ISceneNodeAddOptions,
  ISceneItemInfo,
  ISceneItemFolder,
  SceneItemFolder,
  ISceneItemNode
} from './index';
import Utils from '../utils';
import * as obs from '../obs-api';
import electron from 'electron';
import { Inject } from '../../util/injector';
import { SelectionService, Selection, TNodesList } from 'services/selection';
import { uniqBy } from 'lodash';
import { TSceneNodeInfo } from 'services/scene-collections/nodes/scene-items';
const { ipcRenderer } = electron;


export type TSceneNode = SceneItem | SceneItemFolder;

export interface ISceneHierarchy extends ISceneItemNode {
  children: ISceneHierarchy[];
}

@ServiceHelper()
export class Scene implements ISceneApi {
  id: string;
  name: string;
  nodes: (ISceneItem | ISceneItemFolder)[];

  @Inject() private scenesService: ScenesService;
  @Inject() private sourcesService: SourcesService;
  @Inject() private selectionService: SelectionService;

  private sceneState: IScene;

  constructor(sceneId: string) {
    this.sceneState = this.scenesService.state.scenes[sceneId];
    Utils.applyProxy(this, this.sceneState);
  }

  // getter for backward compatibility with previous version of API
  get items(): ISceneItem[] {
    return this.nodes.filter(node => node.sceneNodeType === 'item') as ISceneItem[];
  }

  getModel(): IScene {
    return this.sceneState;
  }

  getObsScene(): obs.IScene {
    return obs.SceneFactory.fromName(this.id);
  }

  getNode(sceneNodeId: string): TSceneNode {
    const nodeModel = this.sceneState.nodes
      .find(sceneItemModel => sceneItemModel.id === sceneNodeId) as ISceneItem;

    if (!nodeModel) return null;

    return nodeModel.sceneNodeType === 'item' ?
      new SceneItem(this.id, nodeModel.id, nodeModel.sourceId) :
      new SceneItemFolder(this.id, nodeModel.id);
  }

  getItem(sceneItemId: string): SceneItem {
    const node = this.getNode(sceneItemId);
    return (node && node.sceneNodeType === 'item') ? node as SceneItem : null;
  }

  getFolder(sceneFolderId: string): SceneItemFolder {
    const node = this.getNode(sceneFolderId);
    return (node && node.sceneNodeType === 'folder') ? node as SceneItemFolder : null;
  }

  getItems(): SceneItem[] {
    return this.sceneState.nodes
      .filter(node => node.sceneNodeType === 'item')
      .map(item => this.getItem(item.id));
  }

  getFolders(): SceneItemFolder[] {
    return this.sceneState.nodes
      .filter(node => node.sceneNodeType === 'folder')
      .map(item => this.getFolder(item.id));
  }

  getNodes(): TSceneNode[] {
    return (this.sceneState.nodes
      .map(node => {
        return node.sceneNodeType === 'folder' ?
          this.getFolder(node.id) :
          this.getItem(node.id);
      }));
  }

  getRootNodes(): TSceneNode[] {
    return this.getNodes().filter(node => !node.parentId);
  }

  getNodesIds(): string[] {
    return this.sceneState.nodes.map(item => item.id);
  }

  getSelection(itemsList?: TNodesList): Selection {
    return new Selection(this.id, itemsList);
  }

  setName(newName: string) {
    const sceneSource = this.sourcesService.getSource(this.id);
    sceneSource.setName(newName);
    this.SET_NAME(newName);
  }

  createAndAddSource(sourceName: string, type: TSourceType, settings?: Dictionary<any>): SceneItem {
    const source = this.sourcesService.createSource(sourceName, type, settings);
    return this.addSource(source.sourceId);
  }


  addSource(sourceId: string, options: ISceneNodeAddOptions = {}): SceneItem {

    const source = this.sourcesService.getSource(sourceId);
    if (!source) throw new Error(`Source ${sourceId} not found`);

    if (!this.canAddSource(sourceId)) return null;


    const sceneItemId = options.id || ipcRenderer.sendSync('getUniqueId');

    let obsSceneItem: obs.ISceneItem;
    obsSceneItem = this.getObsScene().add(source.getObsInput());

    this.ADD_SOURCE_TO_SCENE(
      sceneItemId,
      source.sourceId,
      obsSceneItem.id
    );
    const sceneItem = this.getItem(sceneItemId);

    sceneItem.loadAttributes();

    // Newly added sources are immediately active
    this.selectionService.select(sceneItemId);

    this.scenesService.itemAdded.next(sceneItem.sceneItemState);
    return sceneItem;
  }

  createFolder(name: string, options: ISceneNodeAddOptions = {}) {

    const id = options.id || ipcRenderer.sendSync('getUniqueId');

    this.ADD_FOLDER_TO_SCENE({
      id,
      name,
      sceneNodeType: 'folder',
      parentId: '',
      childrenIds: []
    });
    return this.getFolder(id);
  }

  removeFolder(folderId: string) {
    const sceneFolder = this.getFolder(folderId);
    if (!sceneFolder) {
      console.error(`SceneFolder ${folderId} not found`);
      return;
    }
    sceneFolder.getSelection().remove();
    sceneFolder.detachParent();
    this.REMOVE_NODE_FROM_SCENE(folderId);
  }

  remove(force?: boolean): IScene {
    return this.scenesService.removeScene(this.id, force);
  }


  removeItem(sceneItemId: string) {
    const sceneItem = this.getItem(sceneItemId);
    if (!sceneItem) {
      console.error(`SceneItem ${sceneItemId} not found`);
      return;
    }
    sceneItem.detachParent();
    sceneItem.getObsSceneItem().remove();
    this.REMOVE_NODE_FROM_SCENE(sceneItemId);
    this.scenesService.itemRemoved.next(sceneItem.sceneItemState);
  }


  setLockOnAllItems(locked: boolean) {
    this.getItems().forEach(item => item.setSettings({ locked }));
  }


  // TODO write tests for this method
  placeAfter(sourceNodeId: string, destNodeId?: string) {

    const sourceNode = this.getNode(sourceNodeId);
    const destNode = this.getNode(destNodeId);

    // move obs items
    const itemsToMove: SceneItem[] = sourceNode.isFolder() ? sourceNode.getNestedItems() : [sourceNode];
    const firstItemIndex = itemsToMove[0].getItemIndex();

    const isForwardDirection = destNode && destNode.getNodeIndex() > sourceNode.getNodeIndex();
    let newItemIndex = 0;


    if (destNode) {
      const destItemIndex = destNode.getItemIndex();
      const destIsFolderWithoutItemsBefore = (
        destNode.isFolder() &&
        destItemIndex === 0 &&
        !destNode.getPrevItem()
      );

      if (destIsFolderWithoutItemsBefore) {
        newItemIndex = 0;
      } else if (isForwardDirection) {
        newItemIndex = destNode.isFolder() ?
          destItemIndex + destNode.getNestedItems().length :
          destItemIndex;
      } else {
        newItemIndex = destItemIndex + 1;
      }
    }

    const obsScene = this.getObsScene();

    if (newItemIndex !== firstItemIndex) {
      for (let i = 0; i < itemsToMove.length; i++) {
        if (isForwardDirection) {
          obsScene.moveItem(firstItemIndex, newItemIndex);
        } else {
          obsScene.moveItem(firstItemIndex + i, newItemIndex);
        }
      }
    }

    // move nodes

    const sceneNodesIds = this.getNodesIds();
    const nodesToMoveIds: string[] = sourceNode.sceneNodeType === 'folder' ?
      [sourceNode.id].concat((sourceNode as SceneItemFolder).getNestedNodesIds()) :
      [sourceNode.id];
    const firstNodeIndex = this.getNode(nodesToMoveIds[0]).getNodeIndex();



    let newNodeIndex = 0;

    if (destNode) {
      const destNodeIndex = destNode.getNodeIndex();

      if (destNodeIndex > firstNodeIndex) {
        newNodeIndex = destNode.isFolder() ?
          destNodeIndex + destNode.getNestedNodes().length - nodesToMoveIds.length + 1 :
          destNodeIndex - nodesToMoveIds.length + 1;
      } else {
        newNodeIndex = destNodeIndex + 1;
      }
    }

    sceneNodesIds.splice(firstNodeIndex, nodesToMoveIds.length);
    sceneNodesIds.splice(newNodeIndex, 0, ...nodesToMoveIds);

    this.SET_NODES_ORDER(sceneNodesIds);
  }

  placeBefore(sourceNodeId: string, destNodeId: string) {
    const destNode = this.getNode(destNodeId).getPrevNode();
    this.placeAfter(sourceNodeId, destNode && destNode.id);
  }


  addSources(nodes: TSceneNodeInfo[]) {
    const arrayItems: (ISceneItemInfo & obs.ISceneItemInfo)[] = [];

    nodes = nodes.filter(sceneNode => {
      if (sceneNode.sceneNodeType === 'folder') return true;
      const item = sceneNode as ISceneItemInfo;
      const source = this.sourcesService.getSource(item.sourceId);
      if (!source) return false;
      arrayItems.push({
        name: source.sourceId,
        id: item.id,
        sourceId: source.sourceId,
        crop: item.crop,
        scaleX: item.scaleX == null ? 1 : item.scaleX,
        scaleY: item.scaleY == null ? 1 : item.scaleY,
        visible: item.visible,
        x: item.x == null ? 0 : item.x,
        y: item.y == null ? 0 : item.y,
        locked: item.locked,
        rotation: item.rotation || 0
      });
      return true;
    });

    const obsSceneItems = obs.addItems(this.getObsScene(), arrayItems);

    // create folder and items
    let itemIndex = 0;
    nodes.forEach((nodeModel) => {
      if (nodeModel.sceneNodeType === 'folder') {
        const folderModel = nodeModel as ISceneItemFolder;
        this.createFolder(folderModel.name, { id: folderModel.id });
      } else {
        const itemModel = nodeModel as ISceneItemInfo;
        this.ADD_SOURCE_TO_SCENE(itemModel.id, itemModel.sourceId, obsSceneItems[itemIndex].id);
        this.getItem(itemModel.id).loadItemAttributes(itemModel);
        itemIndex++;
      }
    });

    // add items to folders
    nodes.forEach(nodeModel => {
      if (nodeModel.sceneNodeType !== 'folder') return;
      const folder = nodeModel as ISceneItemFolder;
      this.getSelection(folder.childrenIds).moveTo(this.id, folder.id);
    });
  }


  canAddSource(sourceId: string): boolean {
    const source = this.sourcesService.getSource(sourceId);
    if (!source) return false;

    // if source is scene then traverse the scenes tree to detect possible infinity scenes loop
    if (source.type !== 'scene') return true;
    if (this.id === source.sourceId) return false;

    const sceneToAdd = this.scenesService.getScene(source.sourceId);
    return !sceneToAdd.hasNestedScene(this.id);
  }


  hasNestedScene(sceneId: string) {
    const childScenes = this.getItems()
      .filter(sceneItem => sceneItem.type === 'scene')
      .map(sceneItem => this.scenesService.getScene(sceneItem.sourceId));

    for (const childScene of childScenes) {
      if (childScene.id === sceneId) return true;
      if (childScene.hasNestedScene(sceneId)) return true;
    }

    return false;
  }


  /**
   * returns scene items of scene + scene items of nested scenes
   */
  getNestedItems(options = { excludeScenes: false }): SceneItem[] {
    let result = this.getItems();
    result
      .filter(sceneItem => sceneItem.type === 'scene')
      .map(sceneItem => {
        return this.scenesService.getScene(sceneItem.sourceId).getNestedItems();
      }).forEach(sceneItems => {
        result = result.concat(sceneItems);
      });
    if (options.excludeScenes) result = result.filter(sceneItem => sceneItem.type !== 'scene');
    return uniqBy(result, 'sceneItemId');
  }


  makeActive() {
    this.scenesService.makeSceneActive(this.id);
  }


  /**
   * returns sources of scene + sources of nested scenes
   * result also includes nested scenes
   */
  getNestedSources(options = { excludeScenes: false }): Source[] {
    const sources = this.getNestedItems(options).map(sceneItem => sceneItem.getSource());
    return uniqBy(sources, 'sourceId');
  }

  @mutation()
  private SET_NAME(newName: string) {
    this.sceneState.name = newName;
  }

  @mutation()
  private ADD_SOURCE_TO_SCENE(
    sceneItemId: string,
    sourceId: string,
    obsSceneItemId: number
  ) {
    this.sceneState.nodes.unshift({
      // This is information that belongs to a scene/source pair

      // The id of the source
      sceneItemId,
      sourceId,
      obsSceneItemId,
      id: sceneItemId,
      parentId: '',
      sceneNodeType: 'item',

      transform: {
        // Position in video space
        position: { x: 0, y: 0 },

        // Scale between 0 and 1
        scale: { x: 1.0, y: 1.0 },

        crop: {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0
        },

        rotation: 0,

      },

      visible: true,
      locked: false
    });
  }

  @mutation()
  private ADD_FOLDER_TO_SCENE(folderModel: ISceneItemFolder) {
    this.sceneState.nodes.unshift(folderModel);
  }


  @mutation()
  private REMOVE_NODE_FROM_SCENE(nodeId: string) {

    if (this.selectionService.isSelected(nodeId)) {
      this.selectionService.deselect(nodeId);
    }

    this.sceneState.nodes = this.sceneState.nodes.filter(item => {
      return item.id !== nodeId;
    });
  }

  @mutation()
  private SET_NODES_ORDER(order: string[]) {

    // TODO: This is O(n^2)
    this.sceneState.nodes = order.map(id => {
      return this.sceneState.nodes.find(item => {
        return item.id === id;
      });
    });
  }

}
