import { IExportData } from "./Interfaces";
import { OrgManager } from "./OrgManager";
import { LogLevel, ResultOperation, Util } from "./Util";
import Bottleneck from "bottleneck";

export class Exporter {

	public static all(org: OrgManager, folderCode: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const promises = [];

			// LEARNING: [PROMISES]: Pushing promises into the array, so they run in parallel.
			promises.push(Exporter.exportData(org, folderCode));
			promises.push(Exporter.exportMetadata(org, folderCode));

			// LEARNING: [PROMISES]: Wait for all promises which are running in parallel
			Promise.all(promises)
				.then(() => { resolve(); })
				.catch((err) => { Util.throwError(err); });
		});
	}

	public static exportData(org: OrgManager, folderCode: string): Promise<void> {
		const exporter: Exporter = new Exporter(true);
		return exporter.export(org, folderCode, org.order.findImportOrder(), 'Data');
	}

	public static exportMetadata(org: OrgManager, folderCode: string): Promise<void> {
		const exporter: Exporter = new Exporter(false);
		return exporter.export(org, folderCode, org.coreMD.sObjects, 'Metadata');
	}

	private mapRecordsFetched: Map<string, IExportData> = new Map<string, IExportData>();
	private metadataReferences: Map<string, Set<string>> = null;
	private limiter = new Bottleneck({maxConcurrent: 5});

	constructor(reportMetadataReferences: boolean) {
		if (reportMetadataReferences) {
			this.metadataReferences = new Map<string, Set<string>>();
		}
	}

	private export(org: OrgManager, folderCode: string, sObjects: string[], type: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const promises = [];

			sObjects.forEach((sObjName) => {
				Util.writeLog(`[${org.alias}] Querying ${type} sObject [${sObjName}]`, LogLevel.TRACE);
				promises.push(
					this.limiter.schedule(() => this.queryData(org, sObjName, folderCode))
					// this.queryData(org, sObjName, folderCode)
				);
				if (false) {
					this.limiter.schedule(() => this.queryData(org, sObjName, folderCode));
				}
			});

			Promise.all(promises)
				.then(() => {
					if (this.metadataReferences !== null) {
						this.metadataReferences.forEach((value, key) => {
							let references = Array.from(value.values());
							const nullIndex = references.indexOf(null);
							if (nullIndex !== -1) {
								references[nullIndex] = '<null>';
							}
							Util.writeLog(`[${org.alias}] data contains the following references for sObject [${key}]: ${references}`, LogLevel.INFO);
						});
					}
					resolve();
				})
				.catch((err) => { Util.throwError(err); });
		});
	}

	private queryData(org: OrgManager, sObjName: string, folderCode: string): Promise<void> {
		this.mapRecordsFetched.set(sObjName, {
			fetched: 0,
			records: [],
			total: -1,
		});

		return new Promise(
			(resolve, reject) => {
				// let records = [];
				org.conn.query(
					this.makeSOQL(org, sObjName),
					{ autoFetch: true },
					(qErr, queryResult) => {
						if (qErr) { reject(qErr); }

						this.getRecords(org, sObjName, queryResult)
							.then(() => {
								const data: IExportData = this.mapRecordsFetched.get(sObjName);
								const msg = `[${org.alias}] Queried [${sObjName}], retrieved ${data.total} records `;
								Util.writeLog(msg, LogLevel.INFO);
								Util.logResultsAdd(org, ResultOperation.EXPORT, sObjName, data.total, 0);

								// Checks....
								Util.assertEquals(data.fetched, data.total, "Not all the records were fetched [1].");
								Util.assertEquals(data.total, data.records.length, "Not all the records were fetched [2].");

								if (data.total >= 0) {
									if (this.metadataReferences != null) {
										var fields = new Map<string, Set<string>>();
										org.discovery.getSObjects().get(sObjName).parents.forEach((parent) => {
											if (org.coreMD.isMD(parent.sObj)) {
												var referenceSet = this.metadataReferences.get(parent.sObj);
												if (referenceSet === undefined) {
													referenceSet = new Set<string>();
													this.metadataReferences.set(parent.sObj, referenceSet);
												}
												fields.set(parent.parentId, referenceSet);
											}
										});
										data.records.forEach((record) => {
											Object.entries(record).forEach(([key, value]) => {
												if (fields.has(key)) {
													fields.get(key).add(<string>value);
												}
											});
										});
									}
									org.settings.writeToFile(org.alias + folderCode, sObjName + ".json", data)
										.then(() => {
											// NOTE: Clean memory, and avoid hep dumps.
											data.records = [];
											// Now, resolve it.
											resolve();
										})
										.catch((err) => { Util.throwError(err); });
								} else {
									resolve();
								}
							})
							.catch((err) => { Util.throwError(err); });
					});
			},
		);
	}

	private makeSOQL(org: OrgManager, sObjName: string): string {
		let soql = "";

		if (org.coreMD.isMD(sObjName)) {
			soql += org.coreMD.makeSOQL(sObjName);
		} else {
			const sObjSettings = org.settings.getSObjectData(sObjName);

			soql += "SELECT " + org.discovery.getFields(sObjName) + " ";
			soql += "FROM " + sObjName + " ";
			if (sObjSettings.where != null) {
				soql += "WHERE " + sObjSettings.where + " ";
			}
			if (sObjSettings.orderBy != null) {
				soql += "ORDER BY " + sObjSettings.orderBy + " ";
			}
			if (sObjSettings.maxRecords > 0) {
				soql += "LIMIT " + sObjSettings.maxRecords + " ";
			}
		}
		Util.writeLog(`[${org.alias}] Querying [${sObjName}] with SOQL: [${soql}]`, LogLevel.TRACE);

		return soql;
	}

	// LEARNING: Querying sObject records. Performs a recursive call to invoke the QueryMore and get all the chunks.
	private getRecords(org: OrgManager, sObjName, queryResult): Promise<void> {
		return new Promise(
			(resolve, reject) => {
				const recordsFetched: IExportData = this.mapRecordsFetched.get(sObjName);
				recordsFetched.total = queryResult.totalSize;
				recordsFetched.fetched += queryResult.records.length;
				recordsFetched.records = recordsFetched.records.concat(queryResult.records);

				if (queryResult.done) {
					resolve();
				} else {
					org.conn.queryMore(queryResult.nextRecordsUrl, { autoFetch: true })
						.then((qRes) => {
							this.getRecords(org, sObjName, qRes)
								.then(() => { resolve(); })
								.catch((err) => { Util.throwError(err); });
						})
						.catch((err) => { Util.throwError(err); });
				}
			});
	}
}
