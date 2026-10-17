package com.playdom.ballistics.game
{
   import flash.display.Bitmap;
   import flash.display.BitmapData;
   import flash.display.BlendMode;
   import flash.display.DisplayObject;
   import flash.display.Graphics;
   import flash.display.Loader;
   import flash.display.Shape;
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.geom.Point;
   import flash.geom.Rectangle;
   import flash.net.URLRequest;
   import flash.utils.ByteArray;
   
   public class Field extends Sprite
   {
      
      private var main:Battlefield;
      
      private var explosionMasks:Array = [];
      
      private var Height:int;
      
      private var explosionRecord:Array = [];
      
      private var mapLoader:Loader;
      
      private var bitmapDataClean:BitmapData;

      // The original map is a loaded SWF.  Ruffle's ERASE/LAYER composition
      // breaks when the camera is transformed, so keep a raster copy that can
      // be cut with the same alpha mask as the collision bitmap.
      private var foregroundBitmapData:BitmapData;

      private var foregroundBitmapDataClean:BitmapData;

      private var foregroundBitmap:Bitmap;
      
      private var contentSprite:Sprite;
      
      private var maskLoader:Loader;
      
      private var circles:Array = [];
      
      private var Width:int;
      
      private var bytes:ByteArray;
      
      private var maskBMD:BitmapData;
      
      private var isHighQuality:Boolean;
      
      public var bitmapData:BitmapData;
      
      private var forgroundName:String;
      
      public function Field()
      {
         super();
         mouseEnabled = false;
         this.isHighQuality = Common.STAGE.quality != "LOW";
         blendMode = BlendMode.NORMAL;
         // The terrain is already a Bitmap; caching the container as a second
         // full-map surface only doubled memory and re-rasterised every crater.
         cacheAsBitmap = false;
         this.main = Battlefield.main;
         this.main.game.addEventListener(Event.CHANGE,this.onGame,false,0,true);
      }
      
      public function checkCollisionPoint(X:Number, Y:Number) : Boolean
      {
         return Boolean(this.bitmapData.getPixel32(int(X),int(Y)) & -16777216);
      }
      
      private function addFromLoader() : void
      {
         var bm:Bitmap = null;
         bm = Bitmap(this.maskLoader.content);
         this.bitmapData = bm.bitmapData;
         this.Width = int(int(this.bitmapData.width));
         this.Height = int(int(this.bitmapData.height));
         this.bitmapDataClean = this.bitmapData.clone();
         this.foregroundBitmapData = new BitmapData(this.Width,this.Height,true,0);
         this.foregroundBitmapData.draw(this.mapLoader.content);
         this.foregroundBitmapDataClean = this.foregroundBitmapData.clone();
         this.foregroundBitmap = new Bitmap(this.foregroundBitmapData);
         this.foregroundBitmap.smoothing = false;
         addChild(this.foregroundBitmap);
         this.mapLoader = null;
         this.maskLoader = null;
      }
      
      private function completeHandler(event:Event = null) : void
      {
         if(this.mapLoader && this.maskLoader && this.mapLoader.content && this.maskLoader.content)
         {
            this.addFromLoader();
            this.main.initFinished();
            dispatchEvent(new Event(Event.COMPLETE));
         }
      }
      
      private function getCircle(rad:uint) : BitmapData
      {
         var i:int = 0;
         var j:int = 0;
         var dX:int = 0;
         var dY:int = 0;
         var dX2:int = 0;
         var dY2:int = 0;
         var result:BitmapData = this.circles[rad];
         if(result)
         {
            return result;
         }
         var dia:int = 2 * rad;
         result = new BitmapData(dia,dia,true,0);
         var RR:int = rad * rad;
         i = 0;
         while(i < dia)
         {
            dX = i - rad;
            dX2 = dX * dX;
            j = 0;
            while(j < dia)
            {
               dY = j - rad;
               dY2 = dY * dY;
               if(dX2 + dY2 > RR)
               {
                  result.setPixel32(i,j,-1);
               }
               j++;
            }
            i++;
         }
         this.circles[rad] = result;
         return result;
      }
      
      public function init() : void
      {
         DisplayUtil.removeAllChildren(this);
         var gameMap:MapProperties = this.main.game.map;
         this.mapLoader = new Loader();
         this.forgroundName = gameMap.foreground;
         var sour:String = "?v=" + Common.cdnVersion;
         var url:String = Common.imageBaseURL + gameMap.foreground + sour;
         if(gameMap.foreground == null)
         {
            trace("ERROR gameMap.foreground is null " + gameMap.name);
         }
         var urlReq:URLRequest = new URLRequest(url);
         this.mapLoader.contentLoaderInfo.addEventListener(Event.COMPLETE,this.completeHandler,false,0,true);
         this.mapLoader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,this.ioErrorHandler,false,0,true);
         this.mapLoader.load(urlReq);
         this.maskLoader = new Loader();
         url = Common.imageBaseURL + gameMap.mask + sour;
         if(gameMap.mask == null)
         {
            trace("ERROR gameMap.mask is null " + gameMap.name);
         }
         urlReq = new URLRequest(url);
         this.maskLoader.contentLoaderInfo.addEventListener(Event.COMPLETE,this.completeHandler,false,0,true);
         this.maskLoader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,this.ioErrorHandler,false,0,true);
         this.maskLoader.load(urlReq);
      }
      
      public function set synchronization(synch:Object) : void
      {
         var exp:Array = null;
         this.explosionMasks = [];
         if(this.explosionRecord.length > 0)
         {
            this.bitmapData = this.bitmapDataClean.clone();
            this.foregroundBitmapData = this.foregroundBitmapDataClean.clone();
            this.foregroundBitmap.bitmapData = this.foregroundBitmapData;
            this.explosionRecord = [];
         }
         for each(exp in synch.explosions)
         {
            this.explode(MathUtil.string2Number(exp[0]),MathUtil.string2Number(exp[1]),MathUtil.string2Number(exp[2]));
         }
      }
      
      public function checkCollisionPointSet(X:Number, Y:Number, pointSet:Array, avg:CollisionAverage) : void
      {
         if(Y < 0)
         {
            trace("Checking collision for xy " + X + " " + Y);
         }
         var p:Point = null;
         var nPoints:uint = 0;
         var pix:int = 0;
         var i:uint = 0;
         if(this.bitmapData)
         {
            nPoints = pointSet.length;
            while(i < nPoints)
            {
               p = pointSet[i];
               pix = int(this.bitmapData.getPixel32(int(p.x + X),int(p.y + Y)));
               if(Y < 0)
               {
                  trace("point details : " + p.x + " " + p.y + " and int py + y " + int(p.y + Y));
               }
               if(pix & -16777216)
               {
                  avg.sumX = Number(Number(avg.sumX + p.x));
                  avg.sumY = Number(Number(avg.sumY + p.y));
                  var _loc9_:CollisionAverage = avg;
                  var _loc10_:Number = _loc9_.nP + 1;
                  _loc9_.nP = _loc10_;
                  _loc9_ = avg;
                  _loc10_ = _loc9_.nGround + 1;
                  _loc9_.nGround = _loc10_;
               }
               i++;
            }
         }
      }
      
      public function explode(X:Number, Y:Number, R:Number) : void
      {
         if(R <= 1)
         {
            return;
         }
         this.explosionRecord.push([MathUtil.number2String(X),MathUtil.number2String(Y),MathUtil.number2String(R)]);
         var Di:Number = Math.round(2 * R);
         var circle:BitmapData = this.getCircle(uint(R));
         var Xi:Number = Math.round(X - R);
         var Yi:Number = Math.round(Y - R);
         var coppyRect:Rectangle = new Rectangle(Xi,Yi,Di,Di);
         var coppyPoint:Point = new Point(Xi,Yi);
         this.bitmapData.copyPixels(this.bitmapData,coppyRect,coppyPoint,circle,new Point(),false);
         // Apply the identical transparent circle to the visible terrain.
         // This is actual terrain removal, not an overlay or decorative mark.
         this.foregroundBitmapData.copyPixels(this.foregroundBitmapData,coppyRect,coppyPoint,circle,new Point(),false);
         // Reassigning invalidates the cached parent on Flash and Ruffle;
         // otherwise a bitmapData mutation can remain hidden until zooming.
         this.foregroundBitmap.bitmapData = this.foregroundBitmapData;
      }
      
      public function get synchronization() : Object
      {
         var result:Object = {};
         result.explosions = this.explosionRecord;
         return result;
      }
      
      private function ioErrorHandler(event:IOErrorEvent) : void
      {
         Ballistics.overlayView.setCriticalErrorPopup("Error: The map failed to load. Reloading the app may help.");
         Ballistics.mainmain.quitGame();
      }
      
      public function percentLoaded() : Number
      {
         var numerator:Number = NaN;
         var denom:Number = NaN;
         var retVal:Number = 0;
         if(this.mapLoader && this.maskLoader)
         {
            numerator = this.mapLoader.contentLoaderInfo.bytesLoaded + this.maskLoader.contentLoaderInfo.bytesLoaded;
            denom = this.mapLoader.contentLoaderInfo.bytesTotal + this.maskLoader.contentLoaderInfo.bytesTotal;
            retVal = numerator / denom;
         }
         else
         {
            retVal = 1;
         }
         return retVal;
      }
      
      public function onGame(event:Event = null) : void
      {
         if(this.main && this.main.game && this.main.game.map)
         {
            if(this.main.game.map.foreground != this.forgroundName)
            {
            }
         }
      }
      
      public function setQuality(high:Boolean = true) : void
      {
         this.isHighQuality = high;
         blendMode = BlendMode.NORMAL;
      }
   }
}

