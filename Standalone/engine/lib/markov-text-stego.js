/**
 * markovTextStego.js (port from Hernan Moraldo's Python implementation)
 *
 * @author Jackson Thuraisamy
 * @version 0.1.0 (2013-12-27)
 */
var MarkovTextStego = function () {
  var stego = this;
  
  // Кодирует строку в массив байт UTF-8
	var stringToUtf8Bytes = function(str) {
		var bytes = [];
		for (var i = 0; i < str.length; i++) {
			var code = str.charCodeAt(i);
			// Обработка суррогатных пар (emoji и т.д.)
			if (code >= 0xD800 && code <= 0xDBFF) {
				var high = code;
				var low = str.charCodeAt(++i);
				code = ((high - 0xD800) * 0x400) + (low - 0xDC00) + 0x10000;
			}
			if (code < 0x80) {
				bytes.push(code);
			} else if (code < 0x800) {
				bytes.push(0xC0 | (code >> 6));
				bytes.push(0x80 | (code & 0x3F));
			} else if (code < 0x10000) {
				bytes.push(0xE0 | (code >> 12));
				bytes.push(0x80 | ((code >> 6) & 0x3F));
				bytes.push(0x80 | (code & 0x3F));
			} else {
				bytes.push(0xF0 | (code >> 18));
				bytes.push(0x80 | ((code >> 12) & 0x3F));
				bytes.push(0x80 | ((code >> 6) & 0x3F));
				bytes.push(0x80 | (code & 0x3F));
			}
		}
		return bytes;
	};

	// Декодирует массив байт UTF-8 обратно в строку
	var utf8BytesToString = function(bytes) {
		var str = '';
		var i = 0;
		while (i < bytes.length) {
			var b = bytes[i];
			var code;
			if (b < 0x80) {
				code = b;
				i += 1;
			} else if ((b & 0xE0) === 0xC0) {
				code = ((b & 0x1F) << 6) | (bytes[i+1] & 0x3F);
				i += 2;
			} else if ((b & 0xF0) === 0xE0) {
				code = ((b & 0x0F) << 12) | ((bytes[i+1] & 0x3F) << 6) | (bytes[i+2] & 0x3F);
				i += 3;
			} else {
				code = ((b & 0x07) << 18) | ((bytes[i+1] & 0x3F) << 12) |
					   ((bytes[i+2] & 0x3F) << 6) | (bytes[i+3] & 0x3F);
				i += 4;
			}
			// Обработка суррогатных пар для символов > 0xFFFF
			if (code > 0xFFFF) {
				code -= 0x10000;
				str += String.fromCharCode(0xD800 + (code >> 10),
										   0xDC00 + (code & 0x3FF));
			} else {
				str += String.fromCharCode(code);
			}
		}
		return str;
	};
  
  // Configure options.
  this.lineDelimiter = '!|!'; // MUST NOT HAVE ANY ALPHABETICAL CHARACTERS!
  this.punctuationList = ['.', '.', '.', '.', '.', '.', '.', '.', '?', '!'];
  this.matchPattern = /([\w\u0400-\u04FF][\w\u0400-\u04FF\.\-\u2019':&]*[\w\u0400-\u04FF])|[\w\u0400-\u04FF]|([:;=]\-?['*\(\)\[\]\\\/DdFPp$Ss0OoXx]+)/g;

  this.BitField = function (data) {
    var self = this;
    var bitStack = '';
    var bitQueue =  '';
    var remainingBytes = data;

    /**
     * Return total length of BitField as number of bits.
     *
     * @return {number} The number of bits in this BitField.
     */
    this.length = function () {
      return (bitStack.length + remainingBytes.length * 8 + bitQueue.length);
    };

    /**
     * Return all data in this BitField that are stored as bytes.
     *
     * @return {array} A byte array.
     */
    this.getAllBytes = function () {
      if ((bitStack.length) || (bitQueue.length)) {
        console.warn("Cannot get all bytes from BitField; " +
                     "some are not stored as bytes");
      }
      return remainingBytes;
    };

    /**
     * Pop bytes from data and push them to bits cache.
     *
     * @private
     * @param {number} numBytes The number of bytes to pop.
     */
    var popBytes = function (numBytes) {
      if (remainingBytes.length < numBytes) {
        console.warn("Too many bytes specified.");
        numBytes = remainingBytes.length;
      }
      for (var i = 1; i <= numBytes; i++) {
        var byte = remainingBytes.shift();
        var bits = ('00000000' + byte.toString(2)).slice(-8);
        bitStack += bits;
      }
    };

    /**
     * Get at least the number of specified bits ready in bitStack.
     *
     * @private
     * @param {number} numBits The number of bits to get ready.
     */
    var getBitsReady = function (numBits) {
      if (self.length() < numBits) {
        console.warn("Too many bits specified, capping to total length.");
        numBits = self.length();
      } else {
        while (bitStack.length < numBits) {
          var numBytes = Math.ceil((numBits - bitStack.length) / 8.0);
          numBytes = Math.min(remainingBytes.length, numBytes);
          popBytes(numBytes);
          // If there are no remaining bytes, move all bits from bitQueue
          // to bitStack.
          if (remainingBytes.length === 0) {
            bitStack += bitQueue;
            bitQueue = "";
          }
        }
      }
    };

    /**
     * Return the number of specified bits.
     *
     * @param {number} numBits The number of bits to return.
     * @return {string} The bits that have been returned.
     */
    this.getBits = function (numBits) {
      getBitsReady(numBits);
      return bitStack.substr(0, numBits);
    };

    /**
     * Pop the number of specified bits.
     *
     * @param {number} numBits The number of bits to return.
     * @return {string} The bits that have been popped.
     */
    this.popBits = function (numBits) {
      getBitsReady(numBits);
      var retrievedBits = bitStack.substr(0, numBits);
      bitStack = bitStack.slice(numBits);
      return retrievedBits;
    };

    /**
     * Push bits into this BitField.
     *
     * @param {string} The bits to be pushed into this BitField.
     */
    this.pushBits = function (bits) {
      bitStack = bits + bitStack;
      while (bitStack.length >= 8) {
        var i = bitStack.length - 8;
        remainingBytes.unshift(parseInt(bitStack.slice(i), 2));
        bitStack = bitStack.substr(0, i);
      }
    };

    /**
     * Enqueue bits into this BitField.
     *
     * @param {string} The bits to be enqueued into this BitField.
     */
    this.enqueueBits = function (bits) {
      bitQueue += bits;
      while (bitQueue.length >= 8) {
        var i = 8;
        remainingBytes.push(parseInt(bitQueue.substr(0, i), 2));
        bitQueue = bitQueue.slice(i);
      }
    };
  };

  this.NGramModelException = function (message) {
    this.message = message;
  };

  this.NGramModel = function (n) {
    if (n === undefined) {
      n = 2;
    }

    // Initialise private instance variables.
    var model = {};
    var corpus = [];

    // Initialise public instance variables.
    this.n = n;
    this.busy = 0;

    /**
     * Given an array of words, compute the probability for each unique word
     * (case-insensitive) represented as a fraction.
     *
     * @private
     * @param {array} An array of words.
     * @return {array} An array of probabilities for each word.
     */
     var computeProbabilities = function (words) {
      var probabilities = {};
      for (var i = 0; i < words.length; i++) {
        var wordLC = words[i].toLowerCase();
        if (probabilities.hasOwnProperty(wordLC)) {
          probabilities[wordLC][1][0] += 1;
        } else {
          probabilities[wordLC] = [words[i], [1, words.length]];
        }
      }
      // Get an array of the values.
      var values = [];
      for (var probability in probabilities) {
        if (!probabilities.hasOwnProperty(probability)) {
          continue;
        }
        values.push(probabilities[probability]);
      }
      return values;
    };

    /**
     * Given an array of word probabilities, return an array containing each
     * word in the number of times it occurred.
     *
     * @private
     * @param {array} An array of word probabilities from computeProbabilities.
     * @return {array} An array of words.
     */
    var probabilitiesToWordList = function (wordProbabilities) {
      var words = [];
      for (var i = 0; i < wordProbabilities.length; i++) {
        for (var j = 0; j < wordProbabilities[i][1][0]; j++) {
          words.push(wordProbabilities[i][0]);
        }
      }
      return words;
    };


    /**
     * Create an n-gram model.
     *
     * @param {array} newCorpus An array of corpus strings.
     * @return {object} The n-gram model.
     */
    this.import = function (newCorpus) {
      // Set messages instance variable.
      corpus = corpus.concat(newCorpus);
      // Set status.
      this.busy = 1;
      // Split messages into word-splitted lines.
      var i, j, k;
      var lines = [];
      for (i = 0; i < corpus.length; i++) {
        var message_lines = corpus[i].split(/\n|\,|\.(?=\s)|\!|\?/);
        for (j = 0; j < message_lines.length; j++) {
          var trimmed_line = message_lines[j].replace(/^[\s\t]*/, '')
                                             .replace(/[\s\t]*$/, '');
          if (trimmed_line.length > 0) {
            var splitted_line = trimmed_line.match(stego.matchPattern);
            if (splitted_line === null) {
              continue;
            }
            if (splitted_line.length >= n) {
              lines.push([].concat([stego.lineDelimiter],
                                   splitted_line,
                                   [stego.lineDelimiter]));
            }
          }
        }
      }
      // Create map of n-grams.
      var ngrams = {};
      var ngram;
      for (i = 0; i < lines.length; i++) {
        // Process n-grams for each line.
        for (j = 0; j < (lines[i].length - 1); j++) {
          // Create n-gram key.
          if (j < n) {
            ngram = [];
            for (k = 0; k < (n - j); k++) {
              ngram.push(lines[i][0]);
            }
            ngram = ngram.concat(lines[i].slice(1)).slice(0, n);
          } else {
            ngram = lines[i].slice((j + 1) - n).slice(0, n);
          }
          // Lowercase words in n-gram key.
          for (k = 0; k < ngram.length; k++) {
            ngram[k] = ngram[k].toLowerCase();
          }
          // Add value(s) to keys.
          if (ngrams.hasOwnProperty(ngram)) {
            ngrams[ngram].push(lines[i][j + 1]);
          } else {
            ngrams[ngram] = [lines[i][j + 1]];
          }
        }
      }
      // Map n-grams to probabilities.
      var numProbabilities = 0;
      for (ngram in ngrams) {
        // Skip elements that are not ngrams.
        if (!ngrams.hasOwnProperty(ngram)) {
          continue;
        }
        var wordProbabilities = computeProbabilities(ngrams[ngram]);
        numProbabilities += wordProbabilities.length;
        ngrams[ngram] = wordProbabilities;
      }
      // Set status.
      this.busy = 0;
      // Check model for errors.
      if (Object.keys(ngrams).length === 0) {
        throw new stego.NGramModelException(
          'No n-grams were constructed.');
      } else if (numProbabilities <= Object.keys(ngrams).length) {
        throw new stego.NGramModelException(
          'All n-grams have only one outcome.');
      }
      // Set model instance variable.
      if (Object.keys(model).length === 0) {
        model = ngrams;
      }
      // Return n-grams model.
      return ngrams;
    };

    /**
     * Create an n-gram model asynchronously (chunked processing with progress callback).
     *
     * @param {array}    newCorpus    An array of corpus strings.
     * @param {Function} onProgress   Callback(progress: 0-1, stage: string)
     * @param {Function} onComplete   Callback(ngrams: object)
     * @param {Function} onError      Callback(error: Error)
     */
    this.importChunked = function (newCorpus, onProgress, onComplete, onError) {
      var self = this;
      var CHUNK_SIZE = 5000; // сообщений на чанк
      var PROCESSING_TIME = 50; // мс на обработку перед yield
      var cancelled = false;   // флаг отмены
      corpus = corpus.concat(newCorpus);
      this.busy = 1;

      var totalMessages = corpus.length;
      var messageIndex = 0;
      var lines = [];
      var ngrams = {};

      /**
       * Отменить текущую операцию импорта.
       */
      this.abort = function () {
        cancelled = true;
        self.busy = 0;
      };

      // Стадия 1: разбиение сообщений на строки
      var stage1Process = function () {
        if (cancelled) return;
        var startTime = Date.now();
        while (messageIndex < totalMessages) {
          var message_lines = corpus[messageIndex].split(/\n|\,|\.(?=\s)|\!|\?/);
          for (var j = 0; j < message_lines.length; j++) {
            var trimmed_line = message_lines[j].replace(/^[\s\t]*/, '')
                                               .replace(/[\s\t]*$/, '');
            if (trimmed_line.length > 0) {
              var splitted_line = trimmed_line.match(stego.matchPattern);
              if (splitted_line !== null && splitted_line.length >= n) {
                lines.push([].concat([stego.lineDelimiter],
                                     splitted_line,
                                     [stego.lineDelimiter]));
              }
            }
          }
          messageIndex++;

          // Проверяем, не вышло ли время — нужно вернуть управление
          if ((Date.now() - startTime) > PROCESSING_TIME) {
            var progress = messageIndex / totalMessages * 0.4; // 40% на стадию 1
            if (onProgress) onProgress(progress, 'Разбиение текста...');
            setTimeout(stage1Process, 0);
            return;
          }
        }

        // Стадия 1 завершена
        if (cancelled) return;
        if (onProgress) onProgress(0.4, 'Построение n-грамм...');
        messageIndex = 0;
        setTimeout(stage2Process, 0);
      };

      // Стадия 2: создание n-грамм
      var stage2Process = function () {
        if (cancelled) return;
        var startTime = Date.now();
        var totalLines = lines.length;
        while (messageIndex < totalLines) {
          var line = lines[messageIndex];
          for (var j = 0; j < (line.length - 1); j++) {
            var ngram;
            if (j < n) {
              ngram = [];
              for (var k = 0; k < (n - j); k++) {
                ngram.push(line[0]);
              }
              ngram = ngram.concat(line.slice(1)).slice(0, n);
            } else {
              ngram = line.slice((j + 1) - n).slice(0, n);
            }
            // Lowercase words in n-gram key.
            for (var k = 0; k < ngram.length; k++) {
              ngram[k] = ngram[k].toLowerCase();
            }
            // Add value(s) to keys.
            if (ngrams.hasOwnProperty(ngram)) {
              ngrams[ngram].push(line[j + 1]);
            } else {
              ngrams[ngram] = [line[j + 1]];
            }
          }
          messageIndex++;

          if ((Date.now() - startTime) > PROCESSING_TIME) {
            var progress = 0.4 + (messageIndex / totalLines) * 0.4; // 40-80%
            if (onProgress) onProgress(progress, 'Построение n-грамм...');
            setTimeout(stage2Process, 0);
            return;
          }
        }

        // Стадия 2 завершена
        if (cancelled) return;
        if (onProgress) onProgress(0.8, 'Вычисление вероятностей...');
        setTimeout(stage3Process, 0);
      };

      // Стадия 3: вычисление вероятностей
      var stage3Process = function () {
        var ngramKeys = Object.keys(ngrams);
        var ngramIndex = 0;
        var numProbabilities = 0;

        var processNgrams = function () {
          if (cancelled) return;
          var startTime = Date.now(); // Обновляем при каждом вызове!
          var startIdx = ngramIndex;
          while (ngramIndex < ngramKeys.length) {
            var ngram = ngramKeys[ngramIndex];
            var wordProbabilities = computeProbabilities(ngrams[ngram]);
            numProbabilities += wordProbabilities.length;
            ngrams[ngram] = wordProbabilities;
            ngramIndex++;

            if ((Date.now() - startTime) > PROCESSING_TIME) {
              var processedInStage = ngramIndex - startIdx;
              var totalInStage = ngramKeys.length;
              var progress = 0.8 + (processedInStage / totalInStage) * 0.2; // 80-100%
              if (onProgress) onProgress(progress, 'Вычисление вероятностей...');
              setTimeout(processNgrams, 0);
              return;
            }
          }

          // Стадия 3 завершена — финализация
          if (cancelled) return;
          self.busy = 0;

          // Check model for errors.
          if (Object.keys(ngrams).length === 0) {
            if (onError) onError(new stego.NGramModelException('No n-grams were constructed.'));
            return;
          } else if (numProbabilities <= Object.keys(ngrams).length) {
            if (onError) onError(new stego.NGramModelException('All n-grams have only one outcome.'));
            return;
          }

          // Set model instance variable.
          if (Object.keys(model).length === 0) {
            model = ngrams;
          }

          if (onProgress) onProgress(1.0, 'Готово!');
          if (onComplete) onComplete(ngrams);
        };

        processNgrams();
      };

      // Запуск стадии 1
      setTimeout(stage1Process, 0);
    };

    /**
     * Update the n-gram model with new corpus strings.
     *
     * @param {array} newCorpus An array of strings.
     * @return {object} The n-gram model.
     */
    this.update = function (newCorpus) {
      // Throw exception if model was not created.
      if (Object.keys(model).length === 0) {
        throw new stego.NGramModelException(
          'Cannot update a model that has no existing corpus.');
      }
      // Create a model from only the corpus update.
      var updateModel = this.import(newCorpus);
      // Merge updateModel with model.
      for (var ngram in updateModel) {
        // Skip elements that are not ngrams.
        if (model.hasOwnProperty(ngram)) {
          var wordListOriginal = probabilitiesToWordList(model[ngram]);
          var wordListNew = probabilitiesToWordList(updateModel[ngram]);
          var mergedWordList = [].concat(wordListOriginal, wordListNew);
          model[ngram] = computeProbabilities(mergedWordList);
        } else {
          model[ngram] = updateModel[ngram];
        }
      }
      // Return model.
      return model;
    };

    /**
     * Return the n-gram model object.
     *
     * @return {object} The n-gram model.
     */
    this.getModel = function () {
      return model;
    };

    /**
     * Return the corpus array.
     *
     * @return {array} The corpus array.
     */
    this.getCorpus = function () {
      return corpus;
    };

    /**
     * Export the n-gram model as a JSON-serializable object.
     * This allows precompiling models to avoid rebuilding them.
     *
     * @return {object} A serializable representation of the model.
     */
    this.exportModel = function () {
      return {
        n: n,
        model: model,
        corpusSize: corpus.length
      };
    };

    /**
     * Import a pre-compiled n-gram model from a JSON-serializable object.
     *
     * @param {object} exportedModel An object from exportModel().
     * @return {object} The n-gram model.
     */
    this.importPrecompiled = function (exportedModel) {
      if (!exportedModel || !exportedModel.model) {
        throw new stego.NGramModelException('Invalid precompiled model.');
      }
      // Restore the model
      model = exportedModel.model;
      n = exportedModel.n || n;
      // Mark as ready
      this.busy = 0;

      // Validate model
      if (Object.keys(model).length === 0) {
        throw new stego.NGramModelException('No n-grams in precompiled model.');
      }

      return model;
    };

    /**
     * Полностью очистить модель и освободить память.
     * Вызывать перед удалением ссылки на модель для корректной выгрузки из ОЗУ.
     */
    this.destroy = function () {
      // Отменить текущую операцию импорта, если она есть
      this.abort && this.abort();
      // Очистить внутренние данные
      model = {};
      corpus = [];
      this.busy = 0;
    };
  };

  this.CodecException = function (message) {
    this.message = message;
  };

  this.Codec = function (ngramModel) {
    if (ngramModel === undefined) {
      console.error('Please specify a NGramModel to create a Codec instance.');
      return;
    }

    // Singleton design pattern.
    if (arguments.callee._singletonInstance) {
      return arguments.callee._singletonInstance;
    }
    arguments.callee._singletonInstance = this;

    // Initialise private instance variables.
    var self = this;

    // Initialise public instance variables.
    this.busy = 0;     // 0 = Ready. 1 = Busy.
    this.progress = 0.0;

    /**
     * Change the NGramModel to a different one.
     *
     * @param {NGramModel} newModel
     */
    this.setModel = function (newModel) {
      ngramModel = newModel;
      return ngramModel;
    };

    /*************************************************************************
     * Encoder Methods
     *************************************************************************/
    /**
     * Encode steganographic layer on top of data.
     *
     * @param {string}     data          Data to be encoded.
     * @return {string}    Encoded data.
     */
    this.encode = function (data) {
    if (data.length === 0) {
        throw new stego.CodecException('No input data was specified.');
    }
    var i;
    this.busy = 1;
    var startWord = [];
    for (i = 0; i < ngramModel.n; i++) {
        startWord.push(stego.lineDelimiter);
    }

    // ИЗМЕНЕНО: используем UTF-8 байты вместо charCodeAt
    var dataByteArray = stringToUtf8Bytes(data);

    // Остальной код без изменений...
    var dataLength = dataByteArray.length;
    var dataLengthByteArray = [];
    for (i = 0; i < 4; i++) {
        var byte = dataLength % 256;
        dataLength = (dataLength - byte) / 256;
        dataLengthByteArray.push(byte);
    }
    var dataLengthBitField = new stego.BitField(dataLengthByteArray);
    var dataLengthWordList = encodeBitsToWordList(dataLengthBitField, startWord);
    var dataBitField = new stego.BitField(dataByteArray);
    var dataWordList = encodeBitsToWordList(dataBitField, this.startWord);
    var wordList = [].concat(dataLengthWordList, dataWordList);
    if (wordList[wordList.length - 1] !== stego.lineDelimiter) {
        var extraWords = finishSentence(wordList[wordList.length - 1], this.startWord);
        wordList = wordList.concat(extraWords);
    }
    var text = wordListToText(wordList);
    this.busy = 0;
    return text;
};

    /**
     * Encode bits to a word list.
     *
     * @private
     * @param {BitField}   bitField
     * @param {array}      startWord
     * @return {array}     An array of words.
     */
    var encodeBitsToWordList = function (bitField, startWord) {
      var words = [];
      var bitRange = ['0', '1'];
      var totalBits = bitField.length();
      var word, wordRange, bitRange2, numBits;
      while (true) {
        // Encode one word.
        wordRange = encodeBitsToWord(bitField, bitRange, startWord);
        word = wordRange[0];
        bitRange = wordRange[1];
        words.push(word);
        // Determine next start word.
        if (word == stego.lineDelimiter) {
          startWord = [];
          for (var i = 0; i < ngramModel.n; i++) {
            startWord.push(stego.lineDelimiter);
          }
        } else {
          startWord = startWord.slice(1);
          startWord.push(word.toLowerCase());
        }
        self.startWord = startWord;
        // Optimisation: remove start of range when identical in both fields.
        bitRange2 = removeCommonBitsFromRange(bitRange);
        numBits = bitRange[0].length - bitRange2[0].length;
        bitField.popBits(numBits);
        bitRange = bitRange2;
        // Set progress.
        self.progress = (totalBits - bitField.length()) / totalBits;
        // Exit when bitField is empty or bitRange has a width of 0.
        if ((bitField.length() === 0) ||
           ((bitField.length() === 1) && (bitRange[0][0] == bitRange[1][0]))) {
          break;
        }
      }
      // Set progress.
      self.progress = 1.0;
      // Return word list.
      return words;
    };

    /**
     * Encode bits to a word.
     *
     * @private
     * @param {BitField}   bitField
     * @param {array[2]}   bitRange
     * @param {array}      startWord
     * @return {array}     An array with the format: [word, bitRange].
     */
    var encodeBitsToWord = function (bitField, bitRange, startWord) {
      // Get probabilities for the start word.
      var wordProbabilities = ngramModel.getModel()[startWord];
      // Compute word ranges.
      var wordRanges = computeWordRanges(bitRange, wordProbabilities,
                                         bitField.length());
      // Seek the right partition for the bits.
      var precision = wordRanges[0][1][0].length;
      var bits = bitField.getBits(precision);
      // Find best word.
      for (var i = 0; i < wordRanges.length; i++) {
        if ((parseInt(wordRanges[i][1][0], 2) <= parseInt(bits, 2)) &&
            (parseInt(wordRanges[i][1][1], 2) >= parseInt(bits, 2))) {
          return wordRanges[i];
        }
      }
    };

    /**
     * Convert a list of words to a text string.
     *
     * @private
     * @param {array} wordList A list of words.
     * @return {string} Text string representing the joined wordList.
     */
    var wordListToText = function (wordList) {
      var text = [];
      var lastWord = stego.lineDelimiter;
      // Iterate through each word in wordList.
      for (var i = 0; i < wordList.length; i++) {
        // Insert first word of sentence (capitalised).
        if ((lastWord == stego.lineDelimiter) &&
            (wordList[i] != stego.lineDelimiter)) {
          text.push(wordList[i][0].toUpperCase() + wordList[i].slice(1));
        }
        // Insert remaining words of sentence.
        if ((text.length > 0) && (lastWord != stego.lineDelimiter)) {
          // Insert word.
          if (wordList[i] != stego.lineDelimiter) {
            text.push(wordList[i]);
          }
          // Insert punctuation.
          if (wordList[i] == stego.lineDelimiter) {
            var j = Math.floor(Math.random() *
                               stego.punctuationList.length);
            var punctuationMark = stego.punctuationList[j];
            text[text.length - 1] += punctuationMark;
          }
        }
        // Set last word.
        lastWord = wordList[i];
      }
      // Return text as a string.
      return text.join(' ');
    };

    /**
     * Finish a sentence given a start word.
     *
     * @private
     * @param {string} startWord
     * @param {string} priorWord
     * @return {array} An array of words that complete the sentence.
     */
    var finishSentence = function (startWord, priorWord) {
      var currentWord = startWord;
      // Lowercase prior words.
      for (var i = 0; i < priorWord.length; i++) {
        priorWord[i] = priorWord[i].toLowerCase();
      }
      var wordList = priorWord;
      while (currentWord !== stego.lineDelimiter) {
        var wordProbabilities = ngramModel.getModel()[priorWord];
        rndWP = Math.floor(Math.random() * wordProbabilities.length);
        currentWord = wordProbabilities[rndWP][0];
        if (currentWord === stego.lineDelimiter) {
          // Add current word to word list.
          wordList.push(currentWord);
        } else {
          // Add current word to word list.
          wordList.push(currentWord);
          // Set new prior word.
          priorWord = wordList.slice(-ngramModel.n);
          // Lowercase prior words.
          for (i = 0; i < priorWord.length; i++) {
            priorWord[i] = priorWord[i].toLowerCase();
          }
        }
      }
      // Return rest of sentence.
      return wordList.slice(ngramModel.n);
    };

    /*************************************************************************
     * Decoder Methods
     *************************************************************************/
    /**
     * Decode steganographic layer from text.
     *
     * @param {string}  text  The encoded data.
     * @return {string}       The original data.
     */
    this.decode = function (text) {
    if (!ngramModel) {
      throw new stego.CodecException('No model set on codec');
    }
    this.numDecodedWords = 0;
    this.busy = 1;
    var wordList = textToWordList(text);
    var dataLength = 0;
    var priorWord = [];
    var i;
    for (i = 0; i < ngramModel.n; i++) {
        priorWord.push(stego.lineDelimiter);
    }
    var bitField = decodeWordListToBitField(wordList, priorWord, 4 * 8);
    var dataLengthByteArray = bitField.getAllBytes().reverse();
    for (i = 0; i < dataLengthByteArray.length; i++) {
        dataLength = dataLength * 256 + dataLengthByteArray[i];
    }
    var dataWordList = wordList.slice(this.numDecodedWords + 1);
    bitField = decodeWordListToBitField(dataWordList, this.startWord, dataLength * 8);
    var dataByteArray = bitField.getAllBytes();
    this.busy = 0;

    // ИЗМЕНЕНО: используем UTF-8 декодирование вместо fromCharCode
    return utf8BytesToString(dataByteArray);
};

    /**
     * Определить, каким корпусом (моделью) был создан stego-текст.
     * Анализирует n-gram из текста и сравнивает с каждой из моделей.
     *
     * @param {string} text       Текст для анализа.
     * @param {object} modelsMap  Объект вида { key: NGramModel, ... }.
     * @param {number} maxSamples Макс. количество n-gram для проверки (по умолч. 50).
     * @return {object|null}      { key: string, score: number, isStego: bool }
     *                            или null, если stego не обнаружен.
     */
    this.identifyCorpus = function (text, modelsMap, maxSamples) {
      if (maxSamples === undefined) maxSamples = 50;
      if (!modelsMap || Object.keys(modelsMap).length === 0) return null;
      if (!ngramModel) return null; // нет модели для анализа

      var wordList = textToWordList(text);
      if (wordList.length < 3) return null; // Слишком короткий текст

      // Извлекаем n-gram из текста
      var textNgrams = [];
      var n = ngramModel.n; // используем n текущей модели как ориентир
      var priorWord = [];
      for (var i = 0; i < n; i++) priorWord.push(stego.lineDelimiter);

      for (var j = 0; j < wordList.length && textNgrams.length < maxSamples; j++) {
        var key = priorWord.join('\x00');
        var model = ngramModel.getModel();
        if (model.hasOwnProperty(key)) {
          // Этот n-gram валиден для текущей модели
          textNgrams.push(key);
        }
        // Сдвигаем окно
        priorWord.push(wordList[j].toLowerCase());
        priorWord = priorWord.slice(-n);
        if (priorWord[priorWord.length - 1] === stego.lineDelimiter) {
          priorWord = [];
          for (var k = 0; k < n; k++) priorWord.push(stego.lineDelimiter);
        }
      }

      if (textNgrams.length === 0) {
        // Текст не является stego-текстом для данной структуры n-gram
        return null;
      }

      // Проверяем каждый корпус
      var bestKey = null;
      var bestScore = 0;

      for (var modelKey in modelsMap) {
        if (!modelsMap.hasOwnProperty(modelKey)) continue;
        var candidateModel = modelsMap[modelKey];
        var candidateNgrams = candidateModel.getModel();
        var candidateN = candidateModel.n;

        // Пересчитаем n-gram текста под n кандидата
        var hits = 0;
        var total = 0;
        priorWord = [];
        for (var i = 0; i < candidateN; i++) priorWord.push(stego.lineDelimiter);

        for (var j = 0; j < wordList.length && total < maxSamples; j++) {
          var cKey = priorWord.join('\x00');
          if (candidateNgrams.hasOwnProperty(cKey)) {
            hits++;
          }
          total++;
          priorWord.push(wordList[j].toLowerCase());
          priorWord = priorWord.slice(-candidateN);
          if (priorWord[priorWord.length - 1] === stego.lineDelimiter) {
            priorWord = [];
            for (var k = 0; k < candidateN; k++) priorWord.push(stego.lineDelimiter);
          }
        }

        var score = total > 0 ? hits / total : 0;
        if (score > bestScore) {
          bestScore = score;
          bestKey = modelKey;
        }
      }

      // Порог: если лучший score < 0.3, текст скорее всего не stego
      if (bestScore < 0.3) return null;

      return {
        key: bestKey,
        score: bestScore,
        isStego: true
      };
    };

    /**
     * Decode a list of words to a BitField.
     *
     * @private
     * @param {array} wordList
     * @param {array[ngramModel.n]} priorWord
     * @param {number} maxBits The maximum size of the BitField.
     * @return {BitField}
     */
    var decodeWordListToBitField = function (wordList, priorWord, maxBits) {
      var bitRange = ['0', '1'];
      var bitField = new stego.BitField([]);
      var i, j;
      var originalMaxBits = maxBits;
      // Compute bit range for each word.
      for (i = 0; i < wordList.length; i++) {
        bitRange = decodeWordToBitRange(wordList[i],
                                        bitRange,
                                        priorWord,
                                        maxBits - bitField.length());
        // Determine priorWord for next iteration.
        priorWord.push(wordList[i].toLowerCase());
        priorWord = priorWord.slice(-ngramModel.n);
        if (priorWord[priorWord.length - 1] === stego.lineDelimiter) {
          priorWord = [];
          for (j = 0; j < ngramModel.n; j++) {
            priorWord.push(stego.lineDelimiter);
          }
        }
        // Throw exception if prior word is invalid n-gram.
        if (ngramModel.getModel().hasOwnProperty(priorWord) === false) {
          throw new stego.CodecException(
            JSON.stringify(priorWord) + ' is an invalid n-gram.');
        }
        self.startWord = priorWord;
        // Simplify bit range, and add bits to BitField.
        var bitRange2 = removeCommonBitsFromRange(bitRange);
        var numBitsRemoved = bitRange[0].length - bitRange2[0].length;
        if ((numBitsRemoved + bitField.length()) > maxBits) {
          numBitsRemoved = maxBits - bitField.length();
        }
        bitField.enqueueBits(bitRange[0].slice(0, numBitsRemoved));
        bitRange = bitRange2;
        // Set progress.
        self.progress = bitField.length() / originalMaxBits;
        // Exit loop when the bitField has reached maxmium length.
        if (bitField.length() === maxBits) {
          break;
        }
        // Exit loop when the bit range refers to only one number.
        if ((bitField.length() === (maxBits - 1)) &&
            (bitRange[0][0] === bitRange[1][0])) {
            bitField.enqueueBits(bitRange[0][0]);
          break;
        }
      }
      // Set progress.
      self.progress = 1.0;
      self.numDecodedWords = i;
      // Return BitField.
      return bitField;
    };

    /**
     * Decode a word to a bit range.
     *
     * @private
     * @param {string}                   word
     * @param {array[2]}                 bitRange
     * @param {array[ngramModel.n]} priorWord
     * @param {number}                   maxBits
     */
    var decodeWordToBitRange = function (word, bitRange, priorWord, maxBits) {
      // Get probabilities for the prior word.
      var wordProbabilities = ngramModel.getModel()[priorWord];
      // Compute word ranges.
      var wordRanges = computeWordRanges(bitRange, wordProbabilities,
                                         maxBits);
      // Return best range.
      for (var i = 0; i < wordRanges.length; i++) {
        if (wordRanges[i][0].toLowerCase() === word) {
          return wordRanges[i][1];
        }
      }
    };

    /**
     * Convert a text string to a list of words.
     *
     * @private
     * @param {string} text A string of encoded text.
     * @return {array}      A list of words.
     */
    var textToWordList = function (text) {
      // Define word list.
      var textMatcher = new RegExp(stego.matchPattern.source + '|\\.|\\!|\\?',
                                   'g');
      var wordList = text.match(textMatcher);
      // Replace punctuation and convert words to lowercase.
      for (var i = 0; i < wordList.length; i++) {
        if (stego.punctuationList.indexOf(wordList[i]) !== -1) {
          wordList[i] = stego.lineDelimiter;
        } else {
          wordList[i] = wordList[i].toLowerCase();
        }
      }
      // Return word list.
      return wordList;
    };

    /*************************************************************************
     * Common Helper Methods
     *************************************************************************/
    /**
     * Compute a list of word ranges.
     *
     * @private
     * @param {array[2]} bitRange A pair of binary numbers telling what the
     *                            range to subdivide is.
     * @param {array} wordProbabilities A list of words in this format:
     *                                  [word, [numerator, denominator]].
     * @param {number} The maximum length allowed for the range, in bits.
     * @return {array} An array where each element is in this format:
     *                 [word, bitRange]
     */
    var computeWordRanges = function (bitRange, wordProbabilities, maxBits) {
      var denominator = wordProbabilities[0][1][1];
      bitRange = addDigitsToRange(bitRange, denominator, maxBits);
      var integerRange = [parseInt(bitRange[0], 2),
                          parseInt(bitRange[1], 2)];
      var maxDigits = bitRange[0].length;
      // Compute word ranges (float).
      var currentLength = integerRange[1] - integerRange[0];
      var step = currentLength / denominator;
      var base = integerRange[0];
      var start = 0;
      var wordRanges1 = [];
      var i, end;
      for (i = 0; i < wordProbabilities.length; i++) {
          end = start + wordProbabilities[i][1][0] * step;
          wordRanges1.push([wordProbabilities[i][0], [start, end]]);
          start = end;
      }
      wordRanges1[wordRanges1.length - 1][1][1] = integerRange[1] - base;
      // Distribute the actual integer ranges as well as possible.
      start = 0;
      var wordRanges2 = [];
      var newWordRange;
      for (i = 0; i < wordRanges1.length; i++) {
        if (wordRanges1[i][1][1] >= start) {
          newWordRange = [wordRanges1[i][0], [start + base,
                          Math.floor(wordRanges1[i][1][1]) + base]];
          wordRanges2.push(newWordRange);
          start = newWordRange[1][1] - base + 1;
        }
      }
      // Convert integers to binary.
      var zeroPad = new Array(1 + maxDigits).join('0');
      for (i = 0; i < wordRanges2.length; i++) {
        wordRanges2[i][1][0] = (zeroPad + wordRanges2[i][1][0].toString(2))
                               .slice(-maxDigits);
        wordRanges2[i][1][1] = (zeroPad + wordRanges2[i][1][1].toString(2))
                               .slice(-maxDigits);
      }
      // Return word ranges.
      return wordRanges2;
    };

    /**
     * Add digits to binary range.
     *
     * @private
     * @param {array[2]} bitRange A binary range representing a subdivision.
     * @param {number} desiredLength The desired width of the range.
     * @param {number} maxDigits The maximum number of digits to have.
     * @return {array[2]} An updated binary range.
     */
    var addDigitsToRange = function (bitRange, desiredLength, maxDigits) {
      var integerRange = [parseInt(bitRange[0], 2),
                          parseInt(bitRange[1], 2)];
      var currentLength = integerRange[1] - integerRange[0] + 1;
      // Return bitRange if its length is equal or greater than desired.
      if (currentLength >= desiredLength) {
        return bitRange;
      }
      var numExtraDigits = Math.ceil(Math.log(desiredLength / currentLength) /
                                     Math.log(2));
      // Reduce the number of extra digits if it surpasses the given max.
      if (bitRange[0].length + numExtraDigits > maxDigits) {
        numExtraDigits = maxDigits - bitRange[0].length;
      }
      // Add extra digits onto bitRange.
      bitRange[0] += new Array(1 + numExtraDigits).join('0');
      bitRange[1] += new Array(1 + numExtraDigits).join('1');
      // Return updated bitRange.
      return bitRange;
    };

    /**
     * Remove common bits from a binary range.
     *
     * @private
     * @param {array[2]} bitRange A binary range representing a subdivision.
     * @return {array[2]} An updated binary range.
     */
    var removeCommonBitsFromRange = function (bitRange) {
      var bitRange2 = bitRange.slice(0);
      while ((bitRange2[0].length > 1) &&
             (bitRange2[0][0] === bitRange2[1][0])) {
        bitRange2 = [bitRange2[0].slice(1), bitRange2[1].slice(1)];
      }
      return bitRange2;
    };
  };
};
